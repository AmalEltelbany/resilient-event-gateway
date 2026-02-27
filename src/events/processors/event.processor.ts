import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { ShipmentsService } from '../../shipments/shipments.service.js';
import { EVENT_DLQ, EVENT_QUEUE } from '../events.constants.js';
import { EventStatus } from '../schemas/event.schema.js';
import { RoutingService } from '../event-routing.service.js';
import { EventsService } from '../events.service.js';

@Injectable()
@Processor(EVENT_QUEUE, { concurrency: 10 })
export class EventProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventProcessor.name);

  constructor(
    @InjectQueue(EVENT_DLQ) private readonly dlqQueue: Queue,
    private readonly eventsService: EventsService,
    private readonly shipmentsService: ShipmentsService,
    private readonly routingService: RoutingService,
  ) {
    super();
  }

  /**
   * On startup, promote any events stuck in PROCESSING back to PENDING.
   *
   * A PROCESSING status that persists across a restart means the worker was killed
   * (OOM, SIGKILL, container eviction) after writing PROCESSING but before completing.
   * BullMQ's at-least-once delivery will re-enqueue those jobs on restart, so the events
   * will be re-processed — but until the worker picks them up again, any caller polling
   * GET /events/:id would see a misleading PROCESSING status for a job that isn't running.
   *
   * This reconciliation runs once at startup, before the worker begins consuming jobs,
   * so the window is closed immediately.
   *
   * Multi-replica caveat: in a multi-instance deployment, replica B restarting will reset
   * events that replica A is actively processing. Replica A will immediately re-write
   * PROCESSING when it next calls updateStatus(), so the race self-heals within milliseconds.
   * The only observable effect is a brief PENDING blip visible to callers polling that event.
   * A production fix would use per-instance locking (e.g. a Redis key with the worker
   * hostname) to scope the reset to jobs owned by this instance only.
   */
  async onApplicationBootstrap(): Promise<void> {
    const count = await this.eventsService.resetStaleProcessing();
    if (count > 0) {
      this.logger.warn(`Startup reconciliation: reset ${count} stale PROCESSING event(s) to PENDING`);
    }
  }

  async process(job: Job): Promise<void> {
    const { eventId, payload } = job.data as { eventId: string; payload: { shipmentId: string } };

    // 1. Skip if already completed (idempotency guard — handles the edge case where a job
    //    re-enters the queue after being completed, e.g. after queue corruption or a manual
    //    retryDeadLettered call that races with the original job completing).
    if (await this.eventsService.isCompleted(eventId)) {
      this.logger.log(`Job ${job.id} (${eventId}) already completed — skipping`);
      return;
    }

    // 2. Fetch shipment BEFORE marking PROCESSING.
    //    Permanent failures (shipment not found) go straight PENDING → FAILED → DLQ without
    //    ever writing PROCESSING, keeping the state machine accurate.
    //    Throwing UnrecoverableError tells BullMQ to skip all remaining retry attempts and
    //    move the job directly to failed state — no backoff delays for permanent errors.
    let shipment;
    try {
      shipment = await this.shipmentsService.findByShipmentId(payload.shipmentId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Permanent failure for job ${job.id} (${eventId}): ${message}`);
      await this.eventsService.updateStatus(eventId, EventStatus.FAILED, {
        errorMessage: message,
      });
      // UnrecoverableError is BullMQ's native primitive for permanent failures.
      // BullMQ skips all remaining retry attempts and moves the job to failed state
      // immediately — no exponential backoff for errors that will never resolve.
      throw new UnrecoverableError(message);
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
  async onFailed(job: Job, error: Error): Promise<void> {
    const { eventId } = job.data as { eventId: string };

    // BullMQ fires `failed` on every failure — both retriable (BullMQ will schedule a retry)
    // and terminal (all attempts exhausted, or UnrecoverableError thrown).
    //
    // Timing note: BullMQ increments job.attemptsMade INSIDE moveToFailed(), which runs
    // before this event fires. So when onFailed runs, attemptsMade already reflects the
    // completed attempt (e.g. first failure → attemptsMade = 1).
    //
    // For normal exhaustion: attemptsMade reaches opts.attempts → isTerminal = true.
    //
    // For UnrecoverableError: BullMQ skips retries and moves the job to failed state
    // immediately, but attemptsMade is only incremented by the one attempt that ran —
    // it does NOT get burned to opts.attempts. So on a first-attempt UnrecoverableError
    // with attempts:3, attemptsMade = 1 and 1 >= 3 is false. We must explicitly check
    // for UnrecoverableError to correctly identify this as a terminal failure.
    const maxAttempts = job.opts.attempts ?? 1;
    const isTerminal = job.attemptsMade >= maxAttempts || error instanceof UnrecoverableError;

    if (!isTerminal) {
      // Job will be retried by BullMQ. Reset DB status to PENDING so the status accurately
      // reflects "waiting for next attempt" rather than stuck at PROCESSING or FAILED.
      await this.eventsService.updateStatus(eventId, EventStatus.PENDING, {
        errorMessage: error.message,
      });
      return;
    }

    this.logger.error(
      `Job ${job.id} (${eventId}) exhausted ${job.attemptsMade} attempts — moving to DLQ`,
      error.stack,
    );

    // Move to DLQ. Stable jobId makes this idempotent: if onFailed fires twice (possible
    // if the worker restarts during the DLQ enqueue), BullMQ deduplicates by jobId.
    await this.dlqQueue.add(
      job.name,
      { ...job.data, originalJobId: job.id, failedReason: error.message, totalAttempts: job.attemptsMade },
      { jobId: `dlq-${job.id}`, removeOnComplete: true, removeOnFail: false },
    );
  }
}
