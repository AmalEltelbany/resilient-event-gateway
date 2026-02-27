import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { EVENT_QUEUE } from './events.constants.js';
import { Event, EventDocument, EventStatus } from './schemas/event.schema.js';

/**
 * OutboxReconciliationService — closes the atomicity gap between enqueue and persist.
 *
 * The gap: EventsService.create() calls eventQueue.add() then eventModel.create().
 * If the process crashes between the two calls, a BullMQ job exists with no MongoDB
 * document. The worker no-ops on every updateStatus() call for that eventId, and the
 * producer's retry is blocked by the Redis idempotency key for 24h.
 *
 * Reconciliation strategy (outbox pattern, simplified):
 *   1. Find PENDING events in MongoDB older than OUTBOX_STALE_THRESHOLD_MS.
 *   2. For each, check whether a BullMQ job for that eventId is still active or
 *      waiting. If not, re-enqueue it with a new jobId so it re-enters the pipeline.
 *
 * This also handles the inverse gap: a PENDING document whose enqueue was lost
 * (e.g. Redis restart between the two calls). Re-enqueueing is idempotent because
 * we use a fresh jobId that bypasses BullMQ's dedup, and the worker's isCompleted()
 * check prevents double-processing if the original job somehow also survived.
 *
 * Both the scan interval and the stale threshold are configurable via environment
 * variables (OUTBOX_INTERVAL_MS, OUTBOX_STALE_THRESHOLD_MS). The interval is wired
 * through SchedulerRegistry so it is truly runtime-configurable — unlike the static
 * @Interval() decorator, which bakes its value in at class-definition time before
 * ConfigService is available and therefore cannot read env vars.
 */
@Injectable()
export class OutboxReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxReconciliationService.name);
  private readonly staleThresholdMs: number;
  private readonly intervalMs: number;

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectQueue(EVENT_QUEUE) private readonly eventQueue: Queue,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.staleThresholdMs = this.config.get<number>('outbox.staleThresholdMs')!;
    this.intervalMs = this.config.get<number>('outbox.intervalMs')!;
  }

  /**
   * Register the reconciliation interval dynamically so OUTBOX_INTERVAL_MS is
   * actually respected at runtime. Called once after all providers are initialised,
   * before the app starts accepting requests.
   */
  onApplicationBootstrap(): void {
    const handle = setInterval(() => void this.reconcile(), this.intervalMs);
    // unref() allows the Node.js process to exit cleanly even if the interval
    // is still pending — important for graceful shutdown and for tests that
    // don't want a dangling timer preventing Jest from exiting.
    handle.unref();
    this.schedulerRegistry.addInterval('outbox-reconciliation', handle);
    this.logger.log(
      `Outbox reconciliation scheduled every ${this.intervalMs}ms ` +
      `(stale threshold: ${this.staleThresholdMs}ms)`,
    );
  }

  async reconcile(): Promise<void> {
    const cutoff = new Date(Date.now() - this.staleThresholdMs);

    // Find PENDING events that have been waiting longer than the stale threshold.
    // createdAt is provided by { timestamps: true } in the Event schema.
    const stalePending = await this.eventModel
      .find(
        { status: EventStatus.PENDING, createdAt: { $lt: cutoff } },
        { eventId: 1, type: 1, source: 1, timestamp: 1, payload: 1 },
      )
      .limit(100) // safety cap per scan — prevents a single run from overwhelming the queue
      .exec();

    if (stalePending.length === 0) return;

    this.logger.warn(`Outbox reconciliation: found ${stalePending.length} stale PENDING event(s)`);

    let requeued = 0;
    for (const event of stalePending) {
      try {
        // Check whether a BullMQ job is already active/waiting for this eventId.
        // getJob() returns null if the job has been removed (removeOnComplete/removeOnFail)
        // or never existed, which is the orphaned-job scenario we need to recover from.
        const existingJob = await this.eventQueue.getJob(event.eventId);
        if (existingJob) {
          // Job is still present in BullMQ — it's being processed or queued normally.
          // Don't interfere; it will complete or fail on its own schedule.
          continue;
        }

        // No active job found — re-enqueue with a unique jobId so BullMQ accepts it
        // even if the original jobId entry is still in the failed/completed history.
        await this.eventQueue.add(
          event.type,
          {
            eventId: event.eventId,
            type: event.type,
            source: event.source,
            timestamp: event.timestamp,
            payload: event.payload,
          },
          { jobId: `reconcile-${event.eventId}-${Date.now()}` },
        );
        requeued++;
        this.logger.log(`Outbox: re-enqueued orphaned event ${event.eventId}`);
      } catch (err) {
        this.logger.error(
          `Outbox: failed to re-enqueue event ${event.eventId}: ${(err as Error).message}`,
        );
      }
    }

    if (requeued > 0) {
      this.logger.warn(`Outbox reconciliation complete: re-enqueued ${requeued} event(s)`);
    }
  }
}
