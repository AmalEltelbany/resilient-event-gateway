import { Test } from '@nestjs/testing';
import { DlqProcessor } from './dlq.processor.js';
import { EventsService } from '../events.service.js';
import { EventStatus } from '../schemas/event.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Record<string, any> = {}) {
  return {
    id: 'dlq-job-1',
    data: {
      eventId: 'evt-1',
      failedReason: 'Routing failure for shipment ship-1',
      originalJobId: 'job-1',
      totalAttempts: 3,
    },
    ...overrides,
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

    it('uses EventsService.updateStatus() — does not access the model directly', async () => {
      // This test verifies the architecture boundary: DlqProcessor must go through
      // EventsService, not inject the Mongoose model. If the provider set above
      // only contains EventsService (no eventModel), the processor must still work.
      const job = makeJob({ data: { eventId: 'evt-2', failedReason: 'timeout', originalJobId: 'j2', totalAttempts: 1 } });
      await expect(processor.process(job)).resolves.not.toThrow();
      expect(eventsService.updateStatus).toHaveBeenCalledWith('evt-2', EventStatus.DEAD_LETTERED, expect.anything());
    });
  });
});
