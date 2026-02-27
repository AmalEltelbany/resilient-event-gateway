import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OutboxReconciliationService } from './outbox-reconciliation.service.js';
import { Event, EventStatus } from './schemas/event.schema.js';
import { EVENT_QUEUE } from './events.constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingEvent(eventId: string, createdAt: Date = new Date(0)) {
  return {
    eventId,
    type: 'shipment.status_updated',
    source: 'fedex',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { shipmentId: 'ship-1' },
    status: EventStatus.PENDING,
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OutboxReconciliationService', () => {
  let service: OutboxReconciliationService;
  let eventModel: any;
  let eventQueue: any;
  let schedulerRegistry: any;

  // Shared find chain builder
  function mockFind(docs: any[]) {
    eventModel.find.mockReturnValue({
      limit: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(docs),
      }),
    });
  }

  beforeEach(async () => {
    eventModel = {
      find: jest.fn(),
    };

    eventQueue = {
      add: jest.fn().mockResolvedValue({}),
      getJob: jest.fn().mockResolvedValue(null), // default: no existing job
    };

    schedulerRegistry = {
      addInterval: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        OutboxReconciliationService,
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getQueueToken(EVENT_QUEUE), useValue: eventQueue },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'outbox.staleThresholdMs') return 300_000;
              if (key === 'outbox.intervalMs') return 300_000;
              return undefined;
            },
          },
        },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
      ],
    }).compile();

    service = module.get(OutboxReconciliationService);
  });

  // -------------------------------------------------------------------------
  // onApplicationBootstrap()
  // -------------------------------------------------------------------------

  describe('onApplicationBootstrap()', () => {
    it('registers a dynamic interval via SchedulerRegistry with the configured ms value', () => {
      service.onApplicationBootstrap();

      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
        'outbox-reconciliation',
        expect.any(Object), // the NodeJS.Timeout handle
      );
    });

    it('registers the interval only once on bootstrap', () => {
      service.onApplicationBootstrap();
      expect(schedulerRegistry.addInterval).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // reconcile() — no stale events
  // -------------------------------------------------------------------------

  describe('reconcile() — no stale events', () => {
    it('exits early without touching the queue when no stale PENDING events exist', async () => {
      mockFind([]);
      await service.reconcile();
      expect(eventQueue.getJob).not.toHaveBeenCalled();
      expect(eventQueue.add).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // reconcile() — orphaned event (no BullMQ job)
  // -------------------------------------------------------------------------

  describe('reconcile() — orphaned event', () => {
    it('re-enqueues a stale PENDING event whose BullMQ job no longer exists', async () => {
      const event = makePendingEvent('evt-orphan');
      mockFind([event]);
      eventQueue.getJob.mockResolvedValue(null); // job is gone

      await service.reconcile();

      expect(eventQueue.getJob).toHaveBeenCalledWith('evt-orphan');
      expect(eventQueue.add).toHaveBeenCalledWith(
        event.type,
        expect.objectContaining({ eventId: 'evt-orphan' }),
        expect.objectContaining({ jobId: expect.stringMatching(/^reconcile-evt-orphan-/) }),
      );
    });

    it('uses a unique reconcile-prefixed jobId to bypass BullMQ dedup', async () => {
      const event = makePendingEvent('evt-orphan-2');
      mockFind([event]);

      await service.reconcile();

      const callArgs = eventQueue.add.mock.calls[0];
      const jobOptions = callArgs[2];
      expect(jobOptions.jobId).toMatch(/^reconcile-evt-orphan-2-\d+$/);
    });
  });

  // -------------------------------------------------------------------------
  // reconcile() — active job still present
  // -------------------------------------------------------------------------

  describe('reconcile() — active job present', () => {
    it('skips re-enqueue when a BullMQ job already exists for the event', async () => {
      const event = makePendingEvent('evt-active');
      mockFind([event]);
      eventQueue.getJob.mockResolvedValue({ id: 'evt-active', state: 'active' }); // job is alive

      await service.reconcile();

      expect(eventQueue.getJob).toHaveBeenCalledWith('evt-active');
      expect(eventQueue.add).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // reconcile() — mixed batch
  // -------------------------------------------------------------------------

  describe('reconcile() — mixed batch', () => {
    it('re-enqueues orphaned events and skips events with active jobs in the same batch', async () => {
      const orphaned = makePendingEvent('evt-lost');
      const active = makePendingEvent('evt-ok');
      mockFind([orphaned, active]);

      eventQueue.getJob
        .mockResolvedValueOnce(null)   // evt-lost: no job
        .mockResolvedValueOnce({ id: 'evt-ok' }); // evt-ok: job exists

      await service.reconcile();

      expect(eventQueue.add).toHaveBeenCalledTimes(1);
      expect(eventQueue.add).toHaveBeenCalledWith(
        orphaned.type,
        expect.objectContaining({ eventId: 'evt-lost' }),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // reconcile() — per-event error isolation
  // -------------------------------------------------------------------------

  describe('reconcile() — error isolation', () => {
    it('continues processing remaining events if one re-enqueue fails', async () => {
      const evt1 = makePendingEvent('evt-fail-enqueue');
      const evt2 = makePendingEvent('evt-success-enqueue');
      mockFind([evt1, evt2]);

      eventQueue.getJob.mockResolvedValue(null);
      eventQueue.add
        .mockRejectedValueOnce(new Error('BullMQ unavailable'))
        .mockResolvedValueOnce({});

      // Should not throw — per-event catch block isolates failures
      await expect(service.reconcile()).resolves.not.toThrow();

      // Second event must still be attempted despite first failing
      expect(eventQueue.add).toHaveBeenCalledTimes(2);
    });
  });
});
