import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShipmentDocument = HydratedDocument<Shipment>;

export enum ShipmentStatus {
  PENDING = 'pending',
  IN_TRANSIT = 'in_transit',
  DELIVERED = 'delivered',
  DELAYED = 'delayed',
}

@Schema({ timestamps: true, collection: 'shipments' })
export class Shipment {
  @Prop({ required: true, unique: true, index: true })
  shipmentId: string;

  @Prop({ required: true, index: true })
  merchantId: string;

  @Prop({ required: true, enum: ShipmentStatus, default: ShipmentStatus.PENDING, index: true })
  status: ShipmentStatus;

  @Prop({ required: true })
  carrier: string;

  @Prop({ required: true })
  origin: string;

  @Prop({ required: true })
  destination: string;
}

export const ShipmentSchema = SchemaFactory.createForClass(Shipment);
