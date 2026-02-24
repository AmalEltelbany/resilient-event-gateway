import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ShipmentsService } from '../../shipments/shipments.service.js';
import { EVENT_DLQ, EVENT_QUEUE } from '../../queues/queue.constants.js';
import { EventStatus } from '../schemas/event.schema.js';
import { RoutingService } from '../routing.service.js';
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

    // 1. Skip if already completed (idempotency guard)
    if (await this.eventsService.isCompleted(eventId)) {
      this.logger.log(`Job ${job.id} (${eventId}) already completed — skipping`);
      return;
    }

    // 2. Mark as processing
    await this.eventsService.updateStatus(eventId, EventStatus.PROCESSING, { incrementAttempts: true });

    // 3. Fetch shipment
    const shipment = await this.shipmentsService.findByShipmentId(payload.shipmentId);

    // 4. Call routing service (may throw on 20% failure)
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
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // Still has retries remaining — BullMQ will reschedule
      return;
    }

    const { eventId } = job.data as { eventId: string };
    this.logger.error(
      `Job ${job.id} (${eventId}) exhausted ${job.attemptsMade} attempts — moving to DLQ`,
      error.stack,
    );

    await this.dlqQueue.add(
      job.name,
      { ...job.data, originalJobId: job.id, failedReason: error.message, totalAttempts: job.attemptsMade },
      { jobId: `dlq:${job.id}`, removeOnComplete: true, removeOnFail: false },
    );
  }
}
