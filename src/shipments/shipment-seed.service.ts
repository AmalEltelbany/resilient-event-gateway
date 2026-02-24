import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Shipment, ShipmentDocument, ShipmentStatus } from './shipment.schema.js';

const CARRIERS = ['FedEx', 'UPS', 'DHL', 'USPS', 'OnTrac'];
const CITIES = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Seattle', 'Miami', 'Denver', 'Boston', 'Atlanta'];
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

    let seeded = 0;
    for (const seed of seeds) {
      await this.shipmentModel
        .updateOne({ shipmentId: seed.shipmentId }, { $setOnInsert: seed }, { upsert: true })
        .exec();
      seeded++;
    }

    this.logger.log(`Shipment seed complete — ${seeded} records upserted`);
  }
}
