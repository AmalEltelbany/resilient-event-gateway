import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { UnrecoverableError } from 'bullmq';
import { NotFoundException } from '@nestjs/common';
import { EventProcessor } from './event.processor.js';
import { EventsService } from '../events.service.js';
import { EventStatus } from '../schemas/event.schema.js';
import { EVENT_DLQ } from '../events.constants.js';
import { ShipmentsService } from '../../shipments/shipments.service.js';
import { RoutingService } from '../event-routing.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Record<string, any> = {}) {
  return {
    id: 'job-1',
    name: 'shipment.status_updated',
    data: { eventId: 'evt-1', payload: { shipmentId: 'ship-1' } },
    opts: { attempts: 3 },
    // BullMQ sets attemptsMade=0 before the first attempt runs inside process().
    // It increments to 1 inside moveToFailed(), which fires BEFORE onFailed().
    // So process() tests should use attemptsMade=0; onFailed() tests set their own.
    attemptsMade: 0,
    stack: '',
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventProcessor', () => {
  let processor: EventProcessor;
  let eventsService: jest.Mocked<Partial<EventsService>>;
  let shipmentsService: any;
  let routingService: any;
  let dlqQueue: any;

  const shipment = { shipmentId: 'ship-1', status: 'in_transit', carrier: 'fedex', destination: 'Cairo' };

  beforeEach(async () => {
    eventsService = {
      isCompleted: jest.fn().mockResolvedValue(false),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      resetStaleProcessing: jest.fn().mockResolvedValue(0),
    };

    shipmentsService = {
      findByShipmentId: jest.fn().mockResolvedValue(shipment),
    };

    routingService = {
      route: jest.fn().mockResolvedValue(undefined),
    };

    dlqQueue = {
      add: jest.fn().mockResolvedValue({}),
    };

    const module = await Test.createTestingModule({
      providers: [
        EventProcessor,
        { provide: EventsService, useValue: eventsService },
        { provide: ShipmentsService, useValue: shipmentsService },
        { provide: RoutingService, useValue: routingService },
        { provide: getQueueToken(EVENT_DLQ), useValue: dlqQueue },
      ],
    }).compile();

    processor = module.get(EventProcessor);
  });

  // -------------------------------------------------------------------------
  // onApplicationBootstrap()
  // -------------------------------------------------------------------------

  describe('onApplicationBootstrap()', () => {
    it('calls resetStaleProcessing on startup', async () => {
      await processor.onApplicationBootstrap();
      expect(eventsService.resetStaleProcessing).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // process() — happy path
  // -------------------------------------------------------------------------

  describe('process() — happy path', () => {
    it('marks PROCESSING then COMPLETED on success', async () => {
      const job = makeJob();
      await processor.process(job);

      const calls = (eventsService.updateStatus as jest.Mock).mock.calls;
      expect(calls[0]).toEqual(['evt-1', EventStatus.PROCESSING, { attempts: 1 }]);
      expect(calls[1]).toEqual(['evt-1', EventStatus.COMPLETED, expect.objectContaining({ processedAt: expect.any(Date) })]);
    });

    it('calls the routing service with the shipment and job name', async () => {
      await processor.process(makeJob());
      expect(routingService.route).toHaveBeenCalledWith(shipment, 'shipment.status_updated');
    });
  });

  // -------------------------------------------------------------------------
  // process() — idempotency guard
  // -------------------------------------------------------------------------

  describe('process() — idempotency guard', () => {
    it('skips processing when event is already COMPLETED', async () => {
      eventsService.isCompleted = jest.fn().mockResolvedValue(true);
      await processor.process(makeJob());
      expect(eventsService.updateStatus).not.toHaveBeenCalled();
      expect(routingService.route).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // process() — permanent failure (shipment not found)
  // -------------------------------------------------------------------------

  describe('process() — permanent failure', () => {
    it('marks FAILED and throws UnrecoverableError when shipment is not found', async () => {
      shipmentsService.findByShipmentId.mockRejectedValue(new NotFoundException('Shipment not found'));
      const job = makeJob();

      await expect(processor.process(job)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(eventsService.updateStatus).toHaveBeenCalledWith(
        'evt-1', EventStatus.FAILED, { errorMessage: 'Shipment not found' },
      );
      // Must NOT mark PROCESSING before a permanent failure
      const processingCall = (eventsService.updateStatus as jest.Mock).mock.calls
        .find(c => c[1] === EventStatus.PROCESSING);
      expect(processingCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // process() — transient failure (routing service error)
  // -------------------------------------------------------------------------

  describe('process() — transient failure', () => {
    it('marks PROCESSING before routing, then rethrows the routing error', async () => {
      routingService.route.mockRejectedValue(new Error('Routing timeout'));
      const job = makeJob();

      await expect(processor.process(job)).rejects.toThrow('Routing timeout');

      const processingCall = (eventsService.updateStatus as jest.Mock).mock.calls
        .find(c => c[1] === EventStatus.PROCESSING);
      expect(processingCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // onFailed() — retriable failure
  // -------------------------------------------------------------------------

  describe('onFailed() — retriable failure', () => {
    it('resets status to PENDING when attempts are not exhausted', async () => {
      // attemptsMade=1 < opts.attempts=3 → not terminal
      const job = makeJob({ attemptsMade: 1, opts: { attempts: 3 } });
      await processor.onFailed(job, new Error('transient'));

      expect(eventsService.updateStatus).toHaveBeenCalledWith(
        'evt-1', EventStatus.PENDING, { errorMessage: 'transient' },
      );
      expect(dlqQueue.add).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onFailed() — terminal by exhaustion
  // -------------------------------------------------------------------------

  describe('onFailed() — terminal by exhaustion', () => {
    it('moves to DLQ when all attempts are exhausted', async () => {
      // attemptsMade=3 >= opts.attempts=3 → terminal
      const job = makeJob({ attemptsMade: 3, opts: { attempts: 3 } });
      await processor.onFailed(job, new Error('exhausted'));

      expect(dlqQueue.add).toHaveBeenCalledWith(
        job.name,
        expect.objectContaining({ eventId: 'evt-1', failedReason: 'exhausted' }),
        expect.objectContaining({ jobId: 'dlq-job-1' }),
      );
      expect(eventsService.updateStatus).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onFailed() — terminal by UnrecoverableError (first attempt)
  // -------------------------------------------------------------------------

  describe('onFailed() — UnrecoverableError', () => {
    it('moves to DLQ on first attempt when error is UnrecoverableError', async () => {
      // attemptsMade=1, opts.attempts=3 — would look retriable by count alone,
      // but UnrecoverableError must always be treated as terminal.
      const job = makeJob({ attemptsMade: 1, opts: { attempts: 3 } });
      const error = new UnrecoverableError('Shipment not found');

      await processor.onFailed(job, error);

      expect(dlqQueue.add).toHaveBeenCalledWith(
        job.name,
        expect.objectContaining({ eventId: 'evt-1' }),
        expect.objectContaining({ jobId: 'dlq-job-1' }),
      );
      expect(eventsService.updateStatus).not.toHaveBeenCalled();
    });
  });
});
