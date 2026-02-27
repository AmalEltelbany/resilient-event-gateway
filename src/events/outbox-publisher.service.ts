import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { EVENT_QUEUE } from './events.constants.js';
import { OutboxEntry, OutboxEntryDocument, OutboxEntryStatus } from './schemas/outbox-entry.schema.js';

/**
 * Polls the `outbox` collection for PENDING entries, publishes each one to BullMQ,
 * and deletes the entry on success.
 *
 * Atomicity: EventsService.create() writes Event + OutboxEntry in a single
 * replica-set transaction. A crash between commit and publish leaves the entry
 * PENDING — it is retried on the next poll cycle.
 *
 * Multi-replica safety: entries are claimed atomically via findOneAndUpdate
 * (PENDING → PROCESSING). A second replica's claim returns null and skips the entry.
 * Stale PROCESSING entries (crash after claim, before delete) are released back
 * to PENDING by releaseStaleProcessing() at startup and on every poll cycle.
 */
@Injectable()
export class OutboxPublisherService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly staleThresholdMs: number;
  private readonly intervalMs: number;

  constructor(
    @InjectModel(OutboxEntry.name) private readonly outboxModel: Model<OutboxEntryDocument>,
    @InjectQueue(EVENT_QUEUE) private readonly eventQueue: Queue,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.staleThresholdMs = this.config.get<number>('outbox.staleThresholdMs')!;
    this.intervalMs = this.config.get<number>('outbox.intervalMs')!;
  }

  onApplicationBootstrap(): void {
    void this.releaseStaleProcessing();
    const handle = setInterval(() => void this.publish(), this.intervalMs);
    handle.unref(); // allow clean shutdown without waiting for the next tick
    this.schedulerRegistry.addInterval('outbox-publisher', handle);
    this.logger.log(
      `Outbox publisher scheduled every ${this.intervalMs}ms ` +
      `(stale threshold: ${this.staleThresholdMs}ms)`,
    );
  }

  async publish(): Promise<void> {
    // Release stale PROCESSING entries on every cycle so a crashed replica's
    // claims are recovered without requiring a full process restart.
    await this.releaseStaleProcessing();

    const pending = await this.outboxModel
      .find({ status: OutboxEntryStatus.PENDING })
      .sort({ createdAt: 1 })
      .limit(50)
      .exec();

    if (pending.length === 0) return;

    this.logger.debug(`Outbox publisher: processing ${pending.length} pending entr${pending.length === 1 ? 'y' : 'ies'}`);

    let published = 0;
    for (const entry of pending) {
      try {
        // Atomic claim — prevents double-publish in multi-replica deployments.
        const claimed = await this.outboxModel.findOneAndUpdate(
          { _id: entry._id, status: OutboxEntryStatus.PENDING },
          { $set: { status: OutboxEntryStatus.PROCESSING } },
          { new: true },
        ).exec();

        if (!claimed) continue;

        // eventId as jobId — BullMQ deduplicates if two cycles race.
        await this.eventQueue.add(entry.type, entry.jobData, { jobId: entry.eventId });
        await this.outboxModel.deleteOne({ _id: entry._id }).exec();

        published++;
        this.logger.log(`Outbox: published event ${entry.eventId} to queue`);
      } catch (err) {
        // Release back to PENDING so the next cycle retries. If this also fails,
        // releaseStaleProcessing() at next startup handles it.
        try {
          await this.outboxModel.updateOne(
            { _id: entry._id },
            { $set: { status: OutboxEntryStatus.PENDING } },
          ).exec();
        } catch (releaseErr) {
          this.logger.error(`Outbox: failed to release ${entry.eventId}: ${(releaseErr as Error).message}`);
        }
        this.logger.error(`Outbox: failed to publish ${entry.eventId}: ${(err as Error).message}`);
      }
    }

    if (published > 0) {
      this.logger.log(`Outbox publisher cycle complete: published ${published} event(s)`);
    }
  }

  async releaseStaleProcessing(): Promise<void> {
    const cutoff = new Date(Date.now() - this.staleThresholdMs);
    const result = await this.outboxModel.updateMany(
      { status: OutboxEntryStatus.PROCESSING, updatedAt: { $lt: cutoff } },
      { $set: { status: OutboxEntryStatus.PENDING } },
    ).exec();

    if (result.modifiedCount > 0) {
      this.logger.warn(
        `Outbox: released ${result.modifiedCount} stale PROCESSING entr${result.modifiedCount === 1 ? 'y' : 'ies'} back to PENDING`,
      );
    }
  }
}
