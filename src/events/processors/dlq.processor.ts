import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EVENT_DLQ } from '../events.constants.js';
import { EventStatus } from '../schemas/event.schema.js';
import { EventsService } from '../events.service.js';

@Injectable()
@Processor(EVENT_DLQ, { concurrency: 5 })
export class DlqProcessor extends WorkerHost {
  private readonly logger = new Logger(DlqProcessor.name);

  constructor(
    // Use EventsService rather than injecting the Mongoose model directly.
    // Routing through the service layer keeps the architecture boundary clean:
    // any future logic added to updateStatus() (metrics, domain events, audit log)
    // is automatically inherited here without changes to this processor.
    private readonly eventsService: EventsService,
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

    await this.eventsService.updateStatus(eventId, EventStatus.DEAD_LETTERED, {
      errorMessage: failedReason,
    });

    this.logger.warn(`Event ${eventId} marked as dead_lettered`);
  }
}
