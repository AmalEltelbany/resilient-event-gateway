import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShipmentDocument, ShipmentStatus } from '../shipments/schemas/shipment.schema.js';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly failureRate: number;

  constructor(private readonly config: ConfigService) {
    this.failureRate = this.config.get<number>('routing.failureRate')!;
  }

  private resolveHandler(eventType: string, status: ShipmentStatus): string {
    if (eventType.includes('payment')) return 'payment-confirmation';
    if (eventType.includes('shipment')) {
      switch (status) {
        case ShipmentStatus.IN_TRANSIT: return 'carrier-update';
        case ShipmentStatus.DELIVERED:  return 'delivery-confirmation';
        case ShipmentStatus.DELAYED:    return 'delay-alert';
        case ShipmentStatus.PENDING:    return 'shipment-intake';
      }
    }
    return 'generic-handler';
  }

  async route(shipment: ShipmentDocument, eventType: string): Promise<void> {
    const handler = this.resolveHandler(eventType, shipment.status);
    this.logger.log(`Resolved handler: ${handler} [shipment: ${shipment.shipmentId}, status: ${shipment.status}, event: ${eventType}]`);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (Math.random() < this.failureRate) {
      this.logger.warn(`Routing failed for shipment ${shipment.shipmentId} (handler: ${handler})`);
      throw new Error(`Routing failure for shipment ${shipment.shipmentId}`);
    }

    this.logger.log(`Routed shipment ${shipment.shipmentId} [${shipment.carrier}] → ${shipment.destination} via ${handler}`);
  }
}
