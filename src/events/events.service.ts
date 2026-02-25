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

    const event = await this.eventModel.create({
      eventId: dto.eventId,
      type: dto.type,
      source: dto.source,
      timestamp: dto.timestamp,
      payload: dto.payload,
    });
    await this.eventQueue.add(dto.type, {
      docId: event.id,
      eventId: dto.eventId,
      type: dto.type,
      source: dto.source,
      timestamp: dto.timestamp,
      payload: dto.payload,
    }, { jobId: dto.eventId });
    this.logger.log(`Event ${dto.eventId} (${dto.type}) enqueued [doc: ${event.id}]`);
    return { status: 'accepted', eventId: dto.eventId };
  }

  async updateStatus(
    eventId: string,
    status: EventStatus,
    extra: { errorMessage?: string | null; processedAt?: Date; incrementAttempts?: boolean } = {},
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (extra.errorMessage !== undefined) update.errorMessage = extra.errorMessage;
    if (extra.processedAt !== undefined) update.processedAt = extra.processedAt;

    const op: Record<string, unknown> = { $set: update };
    if (extra.incrementAttempts) op.$inc = { attempts: 1 };

    await this.eventModel.updateOne({ eventId }, op).exec();
  }

  async isCompleted(eventId: string): Promise<boolean> {
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

  findOne(eventId: string): Promise<EventDocument | null> {
    return this.eventModel.findOne({ eventId }).exec();
  }

  async retryDeadLettered(eventId: string): Promise<{ status: string; eventId: string }> {
    const event = await this.eventModel.findOne({ eventId }).exec();
    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }
    if (event.status !== EventStatus.DEAD_LETTERED) {
      throw new BadRequestException(`Event ${eventId} is not dead_lettered (current: ${event.status})`);
    }

    // Clear the Redis idempotency key so external producers can legitimately
    // re-send this event in the future without being rejected as a duplicate.
    await this.redis.del(`${IDEMPOTENCY_PREFIX}${eventId}`);

    await this.eventModel.updateOne(
      { eventId },
      { $set: { status: EventStatus.PENDING, errorMessage: null, attempts: 0 } },
    ).exec();

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
