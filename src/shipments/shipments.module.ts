import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Shipment, ShipmentSchema } from './shipment.schema.js';
import { ShipmentSeedService } from './shipment-seed.service.js';
import { ShipmentsService } from './shipments.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Shipment.name, schema: ShipmentSchema }]),
  ],
  providers: [ShipmentsService, ShipmentSeedService],
  exports: [ShipmentsService],
})
export class ShipmentsModule {}
