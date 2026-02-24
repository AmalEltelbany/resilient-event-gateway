import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EVENT_QUEUE } from '../../queues/queue.constants.js';

@Processor(EVENT_QUEUE)
export class EventProcessor extends WorkerHost {
  private readonly logger = new Logger(EventProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing job ${job.id} of type "${job.name}"`);
    // TODO: dispatch to handler based on job.name
  }
}
