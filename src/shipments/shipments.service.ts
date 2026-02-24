import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Shipment, ShipmentDocument } from './shipment.schema.js';

@Injectable()
export class ShipmentsService {
  constructor(
    @InjectModel(Shipment.name) private readonly shipmentModel: Model<ShipmentDocument>,
  ) {}

  async findByShipmentId(shipmentId: string): Promise<ShipmentDocument> {
    const shipment = await this.shipmentModel.findOne({ shipmentId }).exec();
    if (!shipment) {
      throw new NotFoundException(`Shipment "${shipmentId}" not found`);
    }
    return shipment;
  }
}
