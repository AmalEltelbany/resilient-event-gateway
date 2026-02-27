import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EventDocument = HydratedDocument<Event>;

export enum EventStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  /**
   * FAILED is a *transient* intermediate state, not a terminal one.
   * It is set by EventProcessor when a permanent error occurs (e.g. shipment not found),
   * immediately before the job is moved to the DLQ. The DlqProcessor then transitions
   * the event to DEAD_LETTERED, which is the actual terminal failure state.
   * A caller observing FAILED for more than a few seconds indicates a DlqProcessor lag.
   */
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

  @Prop({ required: true })
  timestamp: string;

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
