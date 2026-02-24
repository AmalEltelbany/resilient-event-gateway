import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import { EVENT_DLQ } from '../../queues/queue.constants.js';
import { Event, EventDocument, EventStatus } from '../schemas/event.schema.js';

@Injectable()
@Processor(EVENT_DLQ, { concurrency: 5 })
export class DlqProcessor extends WorkerHost {
  private readonly logger = new Logger(DlqProcessor.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<EventDocument>,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const { eventId, failedReason, originalJobId, totalAttempts } = job.data as {
      eventId: string;
      failedReason: string;
      originalJobId: string;
      totalAttempts: number;
    };

    this.logger.error(
      `DLQ processing job ${job.id} (original: ${originalJobId}, eventId: ${eventId}, attempts: ${totalAttempts}): ${failedReason}`,
    );

    await this.eventModel.updateOne(
      { eventId },
      {
        $set: {
          status: EventStatus.DEAD_LETTERED,
          errorMessage: failedReason,
        },
      },
    ).exec();

    this.logger.warn(`Event ${eventId} marked as dead_lettered`);
  }
}
