import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { RoutingService } from './event-routing.service.js';
import { EVENT_DLQ, EVENT_QUEUE } from './events.constants.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';
import { DlqProcessor } from './processors/dlq.processor.js';
import { EventProcessor } from './processors/event.processor.js';
import { ROUTING_SERVICE } from './routing.interface.js';
import { Event, EventSchema } from './schemas/event.schema.js';
import { OutboxEntry, OutboxEntrySchema } from './schemas/outbox-entry.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Event.name, schema: EventSchema },
      { name: OutboxEntry.name, schema: OutboxEntrySchema },
    ]),
    BullModule.registerQueue({ name: EVENT_QUEUE }),
    BullModule.registerQueue({ name: EVENT_DLQ }),
    ShipmentsModule,
  ],
  controllers: [EventsController],
  providers: [
    EventsService,
    EventProcessor,
    DlqProcessor,
    // Bind the routing abstraction to the simulated implementation.
    // To swap for a real HTTP-based service, replace RoutingService here —
    // no other file needs to change.
    { provide: ROUTING_SERVICE, useClass: RoutingService },
    OutboxPublisherService,
  ],
  exports: [EventsService],
})
export class EventsModule {}
