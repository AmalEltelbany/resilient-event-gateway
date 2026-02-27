import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Model, Types } from 'mongoose';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.provider.js';
import { EVENT_QUEUE } from './events.constants.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { PaginationQueryDto } from './dto/pagination-query.dto.js';
import { Event, EventDocument, EventStatus } from './schemas/event.schema.js';

// Idempotency key TTL: must exceed max total retry duration (attempts × backoff)
const IDEMPOTENCY_TTL_S = 86_400; // 24 h
const IDEMPOTENCY_PREFIX = 'idempotency:event:';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectQueue(EVENT_QUEUE) private readonly eventQueue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async create(dto: CreateEventDto): Promise<{ status: string; eventId: string }> {
    // Atomic SET NX EX — 'OK' on first receipt, null on duplicate
    // If Redis is unavailable, degrade gracefully: log and fall through to
    // MongoDB unique index + worker-level check as the idempotency backstop.
    const key = `${IDEMPOTENCY_PREFIX}${dto.eventId}`;
    try {
      const acquired = await this.redis.set(key, '1', 'EX', IDEMPOTENCY_TTL_S, 'NX');
      if (acquired === null) {
        this.logger.warn(`Duplicate event rejected at Redis layer: ${dto.eventId}`);
        throw new ConflictException(`Event ${dto.eventId} has already been received`);
      }
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      this.logger.error(`Redis idempotency check failed — degrading to DB layer: ${(err as Error).message}`);
    }

    // Atomicity gap: enqueue BEFORE writing to MongoDB.
    //
    // Rationale: if we write to MongoDB first and then crash before enqueuing, the result
    // is a permanent ghost event — a PENDING document that will never be processed and can
    // never be re-sent by the producer (the Redis idempotency key blocks retries for 24h).
    //
    // By enqueueing first, the worst-case crash is the opposite: a BullMQ job exists but
    // there is no MongoDB document. The worker's updateStatus() calls will silently no-op
    // on the missing eventId. This is the safer failure mode because:
    //   1. No data is permanently hidden — the producer can detect the missing event
    //   2. The Redis idempotency key may not have been set yet if the crash happens
    //      before the SET NX above (in practice both operations succeed or both fail
    //      together in the common crash scenarios).
    //
    // Known remaining gap: if the crash happens AFTER Redis SET NX and AFTER enqueue
    // but BEFORE MongoDB create, the job runs in the worker (no-ops on missing document)
    // and the producer's retry is rejected as a duplicate. The event is effectively lost.
    // This window is ~1-5ms and requires two consecutive failures. A production deployment
    // should add a background reconciliation job that finds BullMQ jobs with no
    // corresponding MongoDB document and either creates the document or deletes the job
    // (outbox pattern). This is acknowledged as a known eventual-consistency trade-off.
    await this.eventQueue.add(dto.type, {
      eventId: dto.eventId,
      type: dto.type,
      source: dto.source,
      timestamp: dto.timestamp,
      payload: dto.payload,
    }, { jobId: dto.eventId });

    const event = await this.eventModel.create({
      eventId: dto.eventId,
      type: dto.type,
      source: dto.source,
      timestamp: dto.timestamp,
      payload: dto.payload,
    });

    this.logger.log(`Event ${dto.eventId} (${dto.type}) enqueued [doc: ${event.id}]`);
    return { status: 'accepted', eventId: dto.eventId };
  }

  async updateStatus(
    eventId: string,
    status: EventStatus,
    extra: { errorMessage?: string | null; processedAt?: Date; attempts?: number } = {},
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (extra.errorMessage !== undefined) update.errorMessage = extra.errorMessage;
    if (extra.processedAt !== undefined) update.processedAt = extra.processedAt;
    // Set attempts to the explicit value from BullMQ (single source of truth).
    // This avoids double-counting on retries and ensures the counter is always in sync.
    if (extra.attempts !== undefined) update.attempts = extra.attempts;

    await this.eventModel.updateOne({ eventId }, { $set: update }).exec();
  }

  /**
   * Promote all stale PROCESSING events back to PENDING.
   * Called once on worker startup to recover from crash-interrupted jobs.
   * Returns the number of documents updated.
   */
  async resetStaleProcessing(): Promise<number> {
    const result = await this.eventModel.updateMany(
      { status: EventStatus.PROCESSING },
      { $set: { status: EventStatus.PENDING } },
    ).exec();
    return result.modifiedCount;
  }

  async isCompleted(eventId: string): Promise<boolean> {
    // Guard against the edge case where a job appears in the queue after the event is
    // already COMPLETED. This can happen via:
    //   - retryDeadLettered() called on an event that completed between the status check
    //     and the enqueue (prevented by the atomic findOneAndUpdate, but defensive here)
    //   - BullMQ queue corruption / manual job injection
    // Under normal operation this query is never the reason processing is skipped —
    // BullMQ jobId deduplication (layer 3) prevents the same job from being enqueued twice.
    // The index on { eventId: 1 } makes this a covered O(log n) query (~1-3ms).
    const event = await this.eventModel.findOne({ eventId }, { status: 1 }).exec();
    return event?.status === EventStatus.COMPLETED;
  }

  async findAll(query: PaginationQueryDto): Promise<{ data: EventDocument[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = query.limit ?? 20;
    const filter: Record<string, unknown> = {};

    if (query.cursor) {
      filter._id = { $lt: new Types.ObjectId(query.cursor) };
    }

    const data = await this.eventModel
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .exec();

    const hasMore = data.length > limit;
    if (hasMore) data.pop();

    const nextCursor = hasMore && data.length > 0
      ? (data[data.length - 1]._id as Types.ObjectId).toString()
      : null;

    return { data, nextCursor, hasMore };
  }

  async findOne(eventId: string): Promise<EventDocument> {
    const event = await this.eventModel.findOne({ eventId }).exec();
    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }
    return event;
  }

  async retryDeadLettered(eventId: string): Promise<{ status: string; eventId: string }> {
    // Atomic claim: only the first concurrent caller whose filter matches will
    // get a non-null result. A second simultaneous call sees status already
    // PENDING (not DEAD_LETTERED) and gets null → 409, preventing double-enqueue.
    const event = await this.eventModel.findOneAndUpdate(
      { eventId, status: EventStatus.DEAD_LETTERED },
      { $set: { status: EventStatus.PENDING, errorMessage: null, attempts: 0 } },
      { new: true },
    ).exec();

    if (!event) {
      // Either not found, or already claimed by another concurrent request.
      const existing = await this.eventModel.findOne({ eventId }, { status: 1 }).exec();
      if (!existing) {
        throw new NotFoundException(`Event ${eventId} not found`);
      }
      throw new BadRequestException(
        `Event ${eventId} is not dead_lettered (current: ${existing.status})`,
      );
    }

    // NOTE: We intentionally do NOT delete the Redis idempotency key here.
    //
    // This endpoint is an operator-triggered internal retry — the producer is not involved.
    // The new job uses a unique jobId (`retry-{eventId}-{timestamp}`) which bypasses BullMQ's
    // deduplication without needing to touch Redis. Deleting the key would open a window
    // where an external producer could re-send the same eventId and receive a spurious 202,
    // creating a true duplicate in the queue alongside this retry job.
    //
    // If you want to allow producers to legitimately re-send a dead-lettered event (a
    // different policy decision), delete the key explicitly here and document the trade-off.

    await this.eventQueue.add(event.type, {
      docId: event._id.toString(),
      eventId: event.eventId,
      type: event.type,
      source: event.source,
      timestamp: event.timestamp,
      payload: event.payload,
    }, { jobId: `retry-${event.eventId}-${Date.now()}` });

    this.logger.log(`Dead-lettered event ${eventId} re-enqueued for retry`);
    return { status: 'requeued', eventId };
  }
}
