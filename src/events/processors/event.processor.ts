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

    // 1. Skip if already completed (idempotency guard — handles duplicate queue entries)
    if (await this.eventsService.isCompleted(eventId)) {
      this.logger.log(`Job ${job.id} (${eventId}) already completed — skipping`);
      return;
    }

    // 2. Mark as processing and sync the attempt count from BullMQ (single source of truth).
    //    Using attemptsMade+1 (BullMQ is 0-indexed before the attempt runs) avoids
    //    double-incrementing on retries and fixes stuck PROCESSING state on crash recovery.
    await this.eventsService.updateStatus(eventId, EventStatus.PROCESSING, {
      attempts: job.attemptsMade + 1,
    });

    // 3. Fetch shipment — NotFoundException here is a permanent failure (bad data),
    //    not a transient one. We re-throw as a non-retryable error so BullMQ skips
    //    backoff retries and moves the job straight to exhausted → DLQ.
    let shipment;
    try {
      shipment = await this.shipmentsService.findByShipmentId(payload.shipmentId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark as failed immediately and rethrow so BullMQ sees the failure,
      // but exhaust remaining attempts to skip pointless retries.
      this.logger.error(`Permanent failure for job ${job.id} (${eventId}): ${message}`);
      await this.eventsService.updateStatus(eventId, EventStatus.FAILED, {
        errorMessage: message,
      });
      // Force-exhaust attempts so onFailed routes to DLQ without retrying.
      throw Object.assign(new Error(message), { skipRetry: true });
    }

    // 4. Call routing service (may throw on 20% failure — this IS transient, retries apply)
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
    const maxAttempts = job.opts.attempts ?? 1;

    // skipRetry means a permanent failure (e.g. shipment not found) — go straight to DLQ
    // regardless of remaining attempts.
    const isExhausted = job.attemptsMade >= maxAttempts || error.skipRetry === true;

    if (!isExhausted) {
      // Still has retries remaining — reset to PENDING so status accurately reflects
      // that the job will be retried, not permanently failed.
      await this.eventsService.updateStatus(eventId, EventStatus.PENDING, { errorMessage: error.message });
      return;
    }

    this.logger.error(
      `Job ${job.id} (${eventId}) exhausted ${job.attemptsMade} attempts — moving to DLQ`,
      error.stack,
    );

    await this.dlqQueue.add(
      job.name,
      { ...job.data, originalJobId: job.id, failedReason: error.message, totalAttempts: job.attemptsMade },
      { jobId: `dlq-${job.id}`, removeOnComplete: true, removeOnFail: false },
    );
  }
}
