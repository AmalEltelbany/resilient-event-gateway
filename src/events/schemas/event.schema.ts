import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EventDocument = HydratedDocument<Event>;

export enum EventStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  /** @deprecated Kept for backwards-compatibility with existing documents. Do not write. */
  FAILED = 'failed',
  DEAD_LETTERED = 'dead_lettered',
}

@Schema({ timestamps: true, collection: 'events' })
export class Event {
  @Prop({ required: true, unique: true, index: true })
  eventId: string;

  @Prop({ required: true, index: true })
  type: string;

  @Prop({ required: true })
  source: string;

  @Prop({ required: true, type: Date })
  timestamp: Date;

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ enum: EventStatus, default: EventStatus.PENDING, index: true })
  status: EventStatus;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: String, default: null })
  errorMessage: string | null;

  @Prop({ type: Date, default: null })
  processedAt: Date | null;
}

export const EventSchema = SchemaFactory.createForClass(Event);

// Covered scan for status + age queries.
EventSchema.index({ status: 1, createdAt: 1 });
