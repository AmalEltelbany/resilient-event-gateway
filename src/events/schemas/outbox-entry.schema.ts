import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OutboxEntryDocument = HydratedDocument<OutboxEntry>;

export enum OutboxEntryStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
}

@Schema({ timestamps: true, collection: 'outbox' })
export class OutboxEntry {
  @Prop({ required: true, unique: true, index: true })
  eventId: string;

  @Prop({ required: true })
  type: string;

  @Prop({ type: Object, required: true })
  jobData: Record<string, unknown>;

  @Prop({ enum: OutboxEntryStatus, default: OutboxEntryStatus.PENDING, index: true })
  status: OutboxEntryStatus;
}

export const OutboxEntrySchema = SchemaFactory.createForClass(OutboxEntry);

// Covered scan: find PENDING entries by age without a collection scan.
OutboxEntrySchema.index({ status: 1, createdAt: 1 });
