import { Test } from '@nestjs/testing';
import { DlqProcessor } from './dlq.processor.js';
import { EventsService } from '../events.service.js';
import { EventStatus } from '../schemas/event.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(dataOverrides: Record<string, unknown> = {}) {
  return {
    id: 'dlq-job-1',
    name: 'shipment.status_updated',
    data: {
      eventId: 'evt-1',
      failedReason: 'Routing failure for shipment ship-1',
      originalJobId: 'job-1',
      totalAttempts: 3,
      ...dataOverrides,
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DlqProcessor', () => {
  let processor: DlqProcessor;
  let eventsService: jest.Mocked<Partial<EventsService>>;

  beforeEach(async () => {
    eventsService = {
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        DlqProcessor,
        { provide: EventsService, useValue: eventsService },
      ],
    }).compile();

    processor = module.get(DlqProcessor);
  });

  // -------------------------------------------------------------------------
  // process() — core behaviour
  // -------------------------------------------------------------------------

  describe('process()', () => {
    it('marks the event DEAD_LETTERED via EventsService with the failed reason', async () => {
      const job = makeJob();
      await processor.process(job);

      expect(eventsService.updateStatus).toHaveBeenCalledWith(
        'evt-1',
        EventStatus.DEAD_LETTERED,
        { errorMessage: 'Routing failure for shipment ship-1' },
      );
    });

    it('uses job.data.eventId — not the DLQ job id — to identify the document', async () => {
      // The DLQ job.id is `dlq-{originalJobId}`, a different value from eventId.
      // DlqProcessor must use job.data.eventId to update the correct MongoDB document.
      const job = makeJob({ eventId: 'evt-specific-uuid' });
      await processor.process(job);

      const [calledEventId] = (eventsService.updateStatus as jest.Mock).mock.calls[0];
      expect(calledEventId).toBe('evt-specific-uuid');
    });

    it('passes the failedReason string as errorMessage', async () => {
      const job = makeJob({ failedReason: 'Connection timeout after 3 retries' });
      await processor.process(job);

      const [, , extra] = (eventsService.updateStatus as jest.Mock).mock.calls[0];
      expect(extra).toEqual({ errorMessage: 'Connection timeout after 3 retries' });
    });

    it('uses EventsService.updateStatus() — does not access the model directly', async () => {
      // Architecture boundary: DlqProcessor must go through the service layer.
      // The provider set contains only EventsService (no Mongoose model), so if
      // DlqProcessor tries to inject the model directly, NestJS will throw at compile time.
      const job = makeJob({ eventId: 'evt-2', failedReason: 'timeout', totalAttempts: 1 });
      await expect(processor.process(job)).resolves.not.toThrow();
      expect(eventsService.updateStatus).toHaveBeenCalledTimes(1);
    });

    it('calls updateStatus exactly once per job', async () => {
      await processor.process(makeJob());
      expect(eventsService.updateStatus).toHaveBeenCalledTimes(1);
    });

    it('does not swallow errors thrown by updateStatus', async () => {
      (eventsService.updateStatus as jest.Mock).mockRejectedValue(new Error('MongoDB unavailable'));
      await expect(processor.process(makeJob())).rejects.toThrow('MongoDB unavailable');
    });
  });
});
