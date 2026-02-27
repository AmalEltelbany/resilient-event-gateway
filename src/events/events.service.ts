import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Connection, Model, Types } from 'mongoose';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.provider.js';
import { EVENT_QUEUE } from './events.constants.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { PaginationQueryDto } from './dto/pagination-query.dto.js';
import { Event, EventDocument, EventStatus } from './schemas/event.schema.js';
import { OutboxEntry, OutboxEntryDocument } from './schemas/outbox-entry.schema.js';

// Idempotency key TTL: must exceed max total retry duration (attempts × backoff)
const IDEMPOTENCY_TTL_S = 86_400; // 24 h
const IDEMPOTENCY_PREFIX = 'idempotency:event:';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectModel(OutboxEntry.name) private readonly outboxModel: Model<OutboxEntryDocument>,
    @InjectConnection() private readonly connection: Connection,
    @InjectQueue(EVENT_QUEUE) private readonly eventQueue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async create(dto: CreateEventDto): Promise<{ status: string; eventId: string }> {
    // Atomic SET NX EX — 'OK' on first receipt, null on duplicate.
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

    // Write Event + OutboxEntry atomically in a single replica-set transaction.
    // Either both commit or neither does. OutboxPublisherService polls the outbox
    // collection, publishes each PENDING entry to BullMQ, and deletes it on success.
    // A crash between commit and publish leaves the entry PENDING — it is retried
    // on the next poll cycle.
    const jobData = {
      eventId: dto.eventId,
      type: dto.type,
      source: dto.source,
      timestamp: dto.timestamp,
      payload: dto.payload,
    };

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.eventModel.create([{
          eventId: dto.eventId,
          type: dto.type,
          source: dto.source,
          timestamp: dto.timestamp,
          payload: dto.payload,
        }], { session });

        await this.outboxModel.create([{
          eventId: dto.eventId,
          type: dto.type,
          jobData,
        }], { session });
      });
    } finally {
      await session.endSession();
    }

    this.logger.log(`Event ${dto.eventId} (${dto.type}) persisted with outbox entry`);
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
    if (extra.attempts !== undefined) update.attempts = extra.attempts;

    await this.eventModel.updateOne({ eventId }, { $set: update }).exec();
  }

  async resetStaleProcessing(): Promise<number> {
    const result = await this.eventModel.updateMany(
      { status: EventStatus.PROCESSING },
      { $set: { status: EventStatus.PENDING } },
    ).exec();
    return result.modifiedCount;
  }

  async isCompleted(eventId: string): Promise<boolean> {
    // Worker-level idempotency guard: skip jobs whose event already reached a terminal
    // state. retryDeadLettered() resets status to PENDING before re-enqueuing, so a
    // legitimately retried event passes this check correctly.
    const event = await this.eventModel.findOne({ eventId }, { status: 1 }).exec();
    return (
      event?.status === EventStatus.COMPLETED ||
      event?.status === EventStatus.DEAD_LETTERED
    );
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
    // Atomic claim: concurrent calls are serialised by the filter — the second
    // caller finds status already PENDING and gets null → 409.
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

    // The Redis idempotency key is intentionally NOT deleted here. A unique
    // retry-prefixed jobId bypasses BullMQ deduplication without touching Redis.
    // Deleting the key would let a producer re-send the same eventId as a duplicate
    // alongside this retry job.
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
