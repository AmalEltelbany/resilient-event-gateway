import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { ShipmentsService } from '../../shipments/shipments.service.js';
import { EVENT_DLQ, EVENT_QUEUE } from '../events.constants.js';
import { EventsService } from '../events.service.js';
import type { IRoutingService } from '../routing.interface.js';
import { ROUTING_SERVICE } from '../routing.interface.js';
import { EventStatus } from '../schemas/event.schema.js';

@Injectable()
@Processor(EVENT_QUEUE, { concurrency: 10 })
export class EventProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventProcessor.name);

  constructor(
    @InjectQueue(EVENT_DLQ) private readonly dlqQueue: Queue,
    private readonly eventsService: EventsService,
    private readonly shipmentsService: ShipmentsService,
    @Inject(ROUTING_SERVICE) private readonly routingService: IRoutingService,
  ) {
    super();
  }

  // On startup, reset any PROCESSING events left behind by a crashed worker.
  // BullMQ will re-enqueue those jobs; this keeps the visible status accurate in the meantime.
  // Multi-replica caveat: a sibling replica's active jobs may briefly flip to PENDING here,
  // but re-write PROCESSING within milliseconds once the sibling calls updateStatus() again.
  async onApplicationBootstrap(): Promise<void> {
    const count = await this.eventsService.resetStaleProcessing();
    if (count > 0) {
      this.logger.warn(`Startup: reset ${count} stale PROCESSING event(s) to PENDING`);
    }
  }

  async process(job: Job): Promise<void> {
    const { eventId, payload } = job.data as { eventId: string; payload: { shipmentId: string } };

    if (await this.eventsService.isCompleted(eventId)) {
      this.logger.log(`Job ${job.id} (${eventId}) already completed — skipping`);
      return;
    }

    // Fetch shipment first — a missing shipment is a permanent failure.
    // UnrecoverableError skips all retry backoff and moves the job straight to failed,
    // where onFailed() routes it to the DLQ → DEAD_LETTERED. Status never touches FAILED.
    let shipment;
    try {
      shipment = await this.shipmentsService.findByShipmentId(payload.shipmentId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Permanent failure for job ${job.id} (${eventId}): ${message}`);
      throw new UnrecoverableError(message);
    }

    await this.eventsService.updateStatus(eventId, EventStatus.PROCESSING, {
      attempts: job.attemptsMade + 1,
    });

    await this.routingService.route(shipment, job.name);

    await this.eventsService.updateStatus(eventId, EventStatus.COMPLETED, {
      processedAt: new Date(),
      errorMessage: null,
    });

    this.logger.log(`Job ${job.id} (${eventId}) completed`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error): Promise<void> {
    const { eventId } = job.data as { eventId: string };

    // UnrecoverableError does NOT burn attemptsMade to opts.attempts — we must check
    // instanceof explicitly. Normal exhaustion: attemptsMade >= maxAttempts.
    const maxAttempts = job.opts.attempts ?? 1;
    const isTerminal = job.attemptsMade >= maxAttempts || error instanceof UnrecoverableError;

    if (!isTerminal) {
      await this.eventsService.updateStatus(eventId, EventStatus.PENDING, {
        errorMessage: error.message,
      });
      return;
    }

    this.logger.error(
      `Job ${job.id} (${eventId}) exhausted ${job.attemptsMade} attempts — moving to DLQ`,
      error.stack,
    );

    // Stable jobId — idempotent if onFailed fires twice due to worker restart mid-enqueue.
    await this.dlqQueue.add(
      job.name,
      { ...job.data, originalJobId: job.id, failedReason: error.message, totalAttempts: job.attemptsMade },
      { jobId: `dlq-${job.id}`, removeOnComplete: true, removeOnFail: false },
    );
  }
}
