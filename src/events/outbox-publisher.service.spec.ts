import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { EVENT_QUEUE } from './events.constants.js';
import { OutboxPublisherService } from './outbox-publisher.service.js';
import { OutboxEntry, OutboxEntryStatus } from './schemas/outbox-entry.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePendingEntry(eventId: string, createdAt: Date = new Date(0)) {
  return {
    _id: { toString: () => `oid-${eventId}` },
    eventId,
    type: 'shipment.status_updated',
    jobData: {
      eventId,
      type: 'shipment.status_updated',
      source: 'fedex',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      payload: { shipmentId: 'ship-1' },
    },
    status: OutboxEntryStatus.PENDING,
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OutboxPublisherService', () => {
  let service: OutboxPublisherService;
  let outboxModel: any;
  let eventQueue: any;
  let schedulerRegistry: any;

  // Helper: set up the .find().sort().limit().exec() chain
  function mockFind(docs: any[]) {
    outboxModel.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(docs),
        }),
      }),
    });
  }

  beforeEach(async () => {
    outboxModel = {
      find: jest.fn(),
      findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) }),
      deleteOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    eventQueue = {
      add: jest.fn().mockResolvedValue({}),
    };

    schedulerRegistry = {
      addInterval: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        OutboxPublisherService,
        { provide: getModelToken(OutboxEntry.name), useValue: outboxModel },
        { provide: getQueueToken(EVENT_QUEUE), useValue: eventQueue },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'outbox.staleThresholdMs') return 60_000;
              if (key === 'outbox.intervalMs') return 5_000;
              return undefined;
            },
          },
        },
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
      ],
    }).compile();

    service = module.get(OutboxPublisherService);
  });

  // -------------------------------------------------------------------------
  // onApplicationBootstrap()
  // -------------------------------------------------------------------------

  describe('onApplicationBootstrap()', () => {
    it('registers a dynamic interval via SchedulerRegistry', () => {
      // Prevent releaseStaleProcessing from throwing during bootstrap
      outboxModel.updateMany.mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) });

      service.onApplicationBootstrap();

      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
        'outbox-publisher',
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // publish() — empty outbox
  // -------------------------------------------------------------------------

  describe('publish() — empty outbox', () => {
    it('exits early without touching the queue when no PENDING entries exist', async () => {
      mockFind([]);
      await service.publish();
      expect(outboxModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(eventQueue.add).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // publish() — happy path
  // -------------------------------------------------------------------------

  describe('publish() — happy path', () => {
    it('claims the entry, publishes to BullMQ with eventId as jobId, then deletes the entry', async () => {
      const entry = makePendingEntry('evt-1');
      mockFind([entry]);

      // Claim succeeds
      outboxModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ ...entry, status: OutboxEntryStatus.PROCESSING }),
      });

      await service.publish();

      // 1. Atomic claim: PENDING → PROCESSING
      expect(outboxModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: entry._id, status: OutboxEntryStatus.PENDING },
        { $set: { status: OutboxEntryStatus.PROCESSING } },
        { new: true },
      );

      // 2. Publish to BullMQ with eventId as the jobId (enables deduplication)
      expect(eventQueue.add).toHaveBeenCalledWith(
        entry.type,
        entry.jobData,
        { jobId: entry.eventId },
      );

      // 3. Delete the entry on success
      expect(outboxModel.deleteOne).toHaveBeenCalledWith({ _id: entry._id });
    });
  });

  // -------------------------------------------------------------------------
  // publish() — multi-replica claim safety
  // -------------------------------------------------------------------------

  describe('publish() — multi-replica claim safety', () => {
    it('skips publication when another replica has already claimed the entry', async () => {
      const entry = makePendingEntry('evt-claimed');
      mockFind([entry]);

      // findOneAndUpdate returns null → another replica claimed first
      outboxModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await service.publish();

      expect(eventQueue.add).not.toHaveBeenCalled();
      expect(outboxModel.deleteOne).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // publish() — error handling
  // -------------------------------------------------------------------------

  describe('publish() — error handling', () => {
    it('releases the entry back to PENDING if BullMQ publication fails', async () => {
      const entry = makePendingEntry('evt-fail');
      mockFind([entry]);

      outboxModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ ...entry, status: OutboxEntryStatus.PROCESSING }),
      });
      eventQueue.add.mockRejectedValue(new Error('Redis unavailable'));

      await service.publish();

      // Entry must be released back to PENDING
      expect(outboxModel.updateOne).toHaveBeenCalledWith(
        { _id: entry._id },
        { $set: { status: OutboxEntryStatus.PENDING } },
      );
      // Entry must NOT be deleted
      expect(outboxModel.deleteOne).not.toHaveBeenCalled();
    });

    it('continues processing remaining entries if one publication fails', async () => {
      const entry1 = makePendingEntry('evt-fail');
      const entry2 = makePendingEntry('evt-ok');
      mockFind([entry1, entry2]);

      outboxModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn()
          .mockResolvedValueOnce({ ...entry1, status: OutboxEntryStatus.PROCESSING })
          .mockResolvedValueOnce({ ...entry2, status: OutboxEntryStatus.PROCESSING }),
      });

      eventQueue.add
        .mockRejectedValueOnce(new Error('BullMQ down'))
        .mockResolvedValueOnce({});

      // Must not throw — per-entry catch block isolates failures
      await expect(service.publish()).resolves.not.toThrow();

      // Both entries were attempted
      expect(eventQueue.add).toHaveBeenCalledTimes(2);

      // Second entry was deleted (successful publish)
      expect(outboxModel.deleteOne).toHaveBeenCalledTimes(1);
      expect(outboxModel.deleteOne).toHaveBeenCalledWith({ _id: entry2._id });
    });
  });

  // -------------------------------------------------------------------------
  // releaseStaleProcessing()
  // -------------------------------------------------------------------------

  describe('releaseStaleProcessing()', () => {
    it('resets stale PROCESSING entries to PENDING', async () => {
      outboxModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
      });

      await service.releaseStaleProcessing();

      expect(outboxModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ status: OutboxEntryStatus.PROCESSING }),
        { $set: { status: OutboxEntryStatus.PENDING } },
      );
    });

    it('does nothing when no stale PROCESSING entries exist', async () => {
      outboxModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      });

      // Should not throw
      await expect(service.releaseStaleProcessing()).resolves.not.toThrow();
    });
  });
});
