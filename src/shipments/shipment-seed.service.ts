import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Shipment, ShipmentDocument, ShipmentStatus } from './schemas/shipment.schema.js';

const CARRIERS = ['Aramex', 'Egypt Post', 'DHL Egypt', 'Bosta', 'Mylerz'];
const CITIES = ['Cairo', 'Alexandria', 'Giza', 'Port Said', 'Suez', 'Luxor', 'Aswan', 'Mansoura', 'Tanta', 'Hurghada'];
const STATUSES = [
  ShipmentStatus.PENDING,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.DELAYED,
  ShipmentStatus.PENDING,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.DELAYED,
  ShipmentStatus.IN_TRANSIT,
];

@Injectable()
export class ShipmentSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ShipmentSeedService.name);

  constructor(
    @InjectModel(Shipment.name) private readonly shipmentModel: Model<ShipmentDocument>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const seeds = Array.from({ length: 10 }, (_, i) => ({
      shipmentId: `ship-${i + 1}`,
      merchantId: `merchant-${(i % 3) + 1}`,
      status: STATUSES[i],
      carrier: CARRIERS[i % CARRIERS.length],
      origin: CITIES[i],
      destination: CITIES[(i + 5) % CITIES.length],
    }));

    let inserted = 0;
    for (const seed of seeds) {
      const result = await this.shipmentModel
        .updateOne({ shipmentId: seed.shipmentId }, { $setOnInsert: seed }, { upsert: true })
        .exec();
      inserted += result.upsertedCount;
    }

    this.logger.log(`Shipment seed complete — ${inserted} inserted, ${seeds.length - inserted} already existed`);
  }
}
