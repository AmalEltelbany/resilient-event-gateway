import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { EVENT_DLQ, EVENT_QUEUE } from './events.constants.js';
import { EventsController } from './events.controller.js';
import { DlqProcessor } from './processors/dlq.processor.js';
import { EventProcessor } from './processors/event.processor.js';
import { RoutingService } from './event-routing.service.js';
import { Event, EventSchema } from './schemas/event.schema.js';
import { EventsService } from './events.service.js';
import { OutboxReconciliationService } from './outbox-reconciliation.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
    BullModule.registerQueue({ name: EVENT_QUEUE }),
    BullModule.registerQueue({ name: EVENT_DLQ }),
    ShipmentsModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, EventProcessor, DlqProcessor, RoutingService, OutboxReconciliationService],
  exports: [EventsService],
})
export class EventsModule {}
