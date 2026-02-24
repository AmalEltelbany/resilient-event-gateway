import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { EVENT_QUEUE } from '../queues/queue.constants.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { Event, EventDocument, EventStatus } from './schemas/event.schema.js';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
    @InjectQueue(EVENT_QUEUE) private readonly eventQueue: Queue,
  ) {}

  async create(dto: CreateEventDto): Promise<{ status: string; eventId: string }> {
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

  findAll(): Promise<EventDocument[]> {
    return this.eventModel.find().sort({ createdAt: -1 }).exec();
  }

  findOne(id: string): Promise<EventDocument | null> {
    return this.eventModel.findById(id).exec();
  }
}
