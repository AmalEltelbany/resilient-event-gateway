import { Injectable, Logger } from '@nestjs/common';
import { ShipmentDocument } from '../shipments/shipment.schema.js';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  async route(shipment: ShipmentDocument, eventType: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (Math.random() < 0.2) {
      this.logger.warn(`Routing failed for shipment ${shipment.shipmentId} (event: ${eventType})`);
      throw new Error(`Routing failure for shipment ${shipment.shipmentId}`);
    }

    this.logger.log(`Routed shipment ${shipment.shipmentId} [${shipment.carrier}] → ${shipment.destination} (event: ${eventType})`);
  }
}
