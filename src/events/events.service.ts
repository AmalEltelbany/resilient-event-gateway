import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { EVENT_QUEUE } from '../queues/queue.constants.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { Event, EventDocument } from './schemas/event.schema.js';

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

  findAll(): Promise<EventDocument[]> {
    return this.eventModel.find().sort({ createdAt: -1 }).exec();
  }

  findOne(id: string): Promise<EventDocument | null> {
    return this.eventModel.findById(id).exec();
  }
}
