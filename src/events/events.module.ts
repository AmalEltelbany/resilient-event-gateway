import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EVENT_QUEUE } from '../queues/queue.constants.js';
import { HmacGuard } from '../common/guards/hmac.guard.js';
import { EventsController } from './events.controller.js';
import { EventProcessor } from './processors/event.processor.js';
import { Event, EventSchema } from './schemas/event.schema.js';
import { EventsService } from './events.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
    BullModule.registerQueue({ name: EVENT_QUEUE }),
  ],
  controllers: [EventsController],
  providers: [EventsService, EventProcessor, HmacGuard],
  exports: [EventsService],
})
export class EventsModule {}
