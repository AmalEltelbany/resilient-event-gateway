import { ShipmentDocument } from '../shipments/schemas/shipment.schema.js';

export interface IRoutingService {
  route(shipment: ShipmentDocument, eventType: string): Promise<void>;
}

export const ROUTING_SERVICE = 'ROUTING_SERVICE';
