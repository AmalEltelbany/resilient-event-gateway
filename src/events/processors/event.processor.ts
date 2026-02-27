import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ShipmentsService } from '../../shipments/shipments.service.js';
import { EVENT_DLQ, EVENT_QUEUE } from '../events.constants.js';
import { EventStatus } from '../schemas/event.schema.js';
import { RoutingService } from '../event-routing.service.js';
import { EventsService } from '../events.service.js';

@Injectable()
@Processor(EVENT_QUEUE, { concurrency: 10 })
export class EventProcessor extends WorkerHost {
  private readonly logger = new Logger(EventProcessor.name);

  constructor(
    @InjectQueue(EVENT_DLQ) private readonly dlqQueue: Queue,
    private readonly eventsService: EventsService,
    private readonly shipmentsService: ShipmentsService,
    private readonly routingService: RoutingService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const { eventId, payload } = job.data as { eventId: string; payload: { shipmentId: string } };

    // 1. Skip if already completed (idempotency guard — handles the edge case where a job
    //    re-enters the queue after being completed, e.g. via retryDeadLettered on an already
    //    completed event, or after queue corruption).
    if (await this.eventsService.isCompleted(eventId)) {
      this.logger.log(`Job ${job.id} (${eventId}) already completed — skipping`);
      return;
    }

    // 2. Fetch shipment before marking PROCESSING. This avoids writing PROCESSING to the DB
    //    for permanent failures (shipment not found) that will immediately transition to FAILED.
    //    It also tightens the window in which a crash can leave status stuck at PROCESSING:
    //    the PROCESSING write now only happens once we know the shipment exists and routing
    //    is about to be called (the only genuinely async/fallible step).
    //
    //    Crash-recovery note: if the process dies after writing PROCESSING but before
    //    completing, BullMQ's at-least-once delivery will re-enqueue the job on restart.
    //    The worker will re-enter process(), isCompleted() returns false, and status is
    //    overwritten back to PROCESSING immediately — so the stale window is bounded to
    //    the restart time. A production deployment would add a background job that
    //    promotes events stuck in PROCESSING for > N minutes back to PENDING (outbox
    //    reconciliation pattern).
    let shipment;
    try {
      shipment = await this.shipmentsService.findByShipmentId(payload.shipmentId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Permanent failure for job ${job.id} (${eventId}): ${message}`);
      await this.eventsService.updateStatus(eventId, EventStatus.FAILED, {
        errorMessage: message,
      });
      // Force-exhaust retries — shipment not found is not a transient error.
      throw Object.assign(new Error(message), { skipRetry: true });
    }

    // 3. Mark as PROCESSING now that we know routing will be attempted.
    //    Sync the attempt counter from BullMQ (single source of truth).
    await this.eventsService.updateStatus(eventId, EventStatus.PROCESSING, {
      attempts: job.attemptsMade + 1,
    });

    // 4. Call routing service (may throw on transient failures — retries apply)
    await this.routingService.route(shipment, job.name);

    // 5. Mark completed
    await this.eventsService.updateStatus(eventId, EventStatus.COMPLETED, {
      processedAt: new Date(),
      errorMessage: null,
    });

    this.logger.log(`Job ${job.id} (${eventId}) completed`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error & { skipRetry?: boolean }): Promise<void> {
    const { eventId } = job.data as { eventId: string };

    // BullMQ fires `failed` on every failure — both retriable failures (where BullMQ will
    // schedule a retry) and terminal failures (where all attempts are exhausted).
    // We must distinguish between the two WITHOUT replicating BullMQ's own state machine.
    //
    // The idiomatic test: a job is terminal when BullMQ will NOT schedule another attempt,
    // which is when job.attemptsMade has reached (or exceeded) job.opts.attempts, OR when
    // skipRetry is set (permanent failures such as "shipment not found").
    //
    // We read job.opts.attempts — the configured limit — directly from the job options that
    // BullMQ populated. This is the same value BullMQ uses internally, so we are reading
    // from the single source of truth rather than reimplementing it.
    const maxAttempts = job.opts.attempts ?? 1;
    const isTerminal = job.attemptsMade >= maxAttempts || error.skipRetry === true;

    if (!isTerminal) {
      // Job will be retried by BullMQ. Reset DB status to PENDING so the status accurately
      // reflects "waiting for next attempt" rather than stuck at PROCESSING.
      await this.eventsService.updateStatus(eventId, EventStatus.PENDING, {
        errorMessage: error.message,
      });
      return;
    }

    this.logger.error(
      `Job ${job.id} (${eventId}) exhausted ${job.attemptsMade} attempts — moving to DLQ`,
      error.stack,
    );

    // Move to DLQ. Use a stable jobId so that double-firing of this handler (theoretically
    // possible if the worker restarts during the DLQ enqueue) is idempotent — BullMQ will
    // reject the duplicate jobId.
    await this.dlqQueue.add(
      job.name,
      { ...job.data, originalJobId: job.id, failedReason: error.message, totalAttempts: job.attemptsMade },
      { jobId: `dlq-${job.id}`, removeOnComplete: true, removeOnFail: false },
    );
  }
}
