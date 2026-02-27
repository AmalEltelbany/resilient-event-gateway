import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.provider.js';
import { EVENT_QUEUE } from './events.constants.js';
import { EventsService } from './events.service.js';
import { Event, EventStatus } from './schemas/event.schema.js';
import { OutboxEntry } from './schemas/outbox-entry.schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDto(overrides = {}) {
  return {
    eventId: 'evt-uuid-1',
    type: 'shipment.status_updated',
    source: 'fedex',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    payload: { shipmentId: 'ship-1' },
    ...overrides,
  };
}

function makeEvent(overrides = {}) {
  return {
    _id: { toString: () => 'mongo-id-1' },
    id: 'mongo-id-1',
    eventId: 'evt-uuid-1',
    type: 'shipment.status_updated',
    source: 'fedex',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    payload: { shipmentId: 'ship-1' },
    status: EventStatus.PENDING,
    attempts: 0,
    errorMessage: null,
    processedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventsService', () => {
  let service: EventsService;
  let eventModel: any;
  let outboxModel: any;
  let eventQueue: any;
  let redis: any;
  let mockSession: any;

  beforeEach(async () => {
    // Mock the MongoDB session / transaction.
    // withTransaction executes the callback immediately so we can assert on
    // what create() does inside the transaction.
    mockSession = {
      withTransaction: jest.fn().mockImplementation(async (fn) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    const mockConnection = {
      startSession: jest.fn().mockResolvedValue(mockSession),
    };

    eventModel = {
      create: jest.fn().mockResolvedValue([makeEvent()]),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) }),
      findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };

    outboxModel = {
      create: jest.fn().mockResolvedValue([{}]),
    };

    eventQueue = {
      add: jest.fn().mockResolvedValue({}),
    };

    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getModelToken(OutboxEntry.name), useValue: outboxModel },
        { provide: getConnectionToken(), useValue: mockConnection },
        { provide: getQueueToken(EVENT_QUEUE), useValue: eventQueue },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get(EventsService);
  });

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe('create()', () => {
    it('writes Event and OutboxEntry in the same transaction on the happy path', async () => {
      const dto = makeDto();

      const result = await service.create(dto);

      expect(result).toEqual({ status: 'accepted', eventId: dto.eventId });

      // Both writes must happen inside withTransaction
      expect(mockSession.withTransaction).toHaveBeenCalledTimes(1);
      expect(eventModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({ eventId: dto.eventId })],
        { session: mockSession },
      );
      expect(outboxModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({ eventId: dto.eventId })],
        { session: mockSession },
      );

      // Session must be closed regardless of outcome
      expect(mockSession.endSession).toHaveBeenCalled();
    });

    it('does NOT enqueue to BullMQ directly — queuing is deferred to OutboxPublisherService', async () => {
      await service.create(makeDto());
      expect(eventQueue.add).not.toHaveBeenCalled();
    });

    it('throws ConflictException when Redis SET NX returns null (duplicate)', async () => {
      redis.set.mockResolvedValue(null);
      await expect(service.create(makeDto())).rejects.toBeInstanceOf(ConflictException);
      expect(mockSession.withTransaction).not.toHaveBeenCalled();
    });

    it('degrades gracefully when Redis throws — falls through to transaction', async () => {
      redis.set.mockRejectedValue(new Error('Redis connection refused'));

      // Should NOT throw — Redis failure is non-fatal, transaction still runs
      await expect(service.create(makeDto())).resolves.toMatchObject({ status: 'accepted' });
      expect(mockSession.withTransaction).toHaveBeenCalledTimes(1);
    });

    it('closes the session even when the transaction throws', async () => {
      mockSession.withTransaction.mockRejectedValue(new Error('transaction aborted'));

      await expect(service.create(makeDto())).rejects.toThrow('transaction aborted');
      expect(mockSession.endSession).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // isCompleted()
  // -------------------------------------------------------------------------

  describe('isCompleted()', () => {
    it('returns true when event status is COMPLETED', async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(makeEvent({ status: EventStatus.COMPLETED })),
      });
      await expect(service.isCompleted('evt-uuid-1')).resolves.toBe(true);
    });

    it('returns true when event status is DEAD_LETTERED', async () => {
      // A zombie job from the original queue must not re-process a dead-lettered event
      // that the operator has not yet retried. retryDeadLettered() resets status to
      // PENDING before re-enqueueing, so a legitimately retried event passes this guard.
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(makeEvent({ status: EventStatus.DEAD_LETTERED })),
      });
      await expect(service.isCompleted('evt-uuid-1')).resolves.toBe(true);
    });

    it('returns false when event status is PENDING', async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(makeEvent({ status: EventStatus.PENDING })),
      });
      await expect(service.isCompleted('evt-uuid-1')).resolves.toBe(false);
    });

    it('returns false when event document does not exist', async () => {
      eventModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      await expect(service.isCompleted('evt-uuid-1')).resolves.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // resetStaleProcessing()
  // -------------------------------------------------------------------------

  describe('resetStaleProcessing()', () => {
    it('bulk-resets all PROCESSING events to PENDING and returns the count', async () => {
      eventModel.updateMany.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 3 }),
      });
      const count = await service.resetStaleProcessing();
      expect(count).toBe(3);
      expect(eventModel.updateMany).toHaveBeenCalledWith(
        { status: EventStatus.PROCESSING },
        { $set: { status: EventStatus.PENDING } },
      );
    });

    it('returns 0 when no stale events exist', async () => {
      await expect(service.resetStaleProcessing()).resolves.toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // retryDeadLettered()
  // -------------------------------------------------------------------------

  describe('retryDeadLettered()', () => {
    it('resets status, re-enqueues with a unique jobId, and does NOT delete the Redis key', async () => {
      const doc = makeEvent({ status: EventStatus.DEAD_LETTERED });
      eventModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });

      const result = await service.retryDeadLettered('evt-uuid-1');

      expect(result).toEqual({ status: 'requeued', eventId: 'evt-uuid-1' });
      // The jobId must start with 'retry-' to bypass BullMQ dedup without touching Redis
      expect(eventQueue.add).toHaveBeenCalledWith(
        doc.type,
        expect.objectContaining({ eventId: doc.eventId }),
        expect.objectContaining({ jobId: expect.stringMatching(/^retry-/) }),
      );
      // Redis key must NOT be deleted — preserving it prevents producer re-send duplicates
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when event does not exist', async () => {
      eventModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      eventModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(service.retryDeadLettered('missing-id')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when event is not dead_lettered', async () => {
      eventModel.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(makeEvent({ status: EventStatus.COMPLETED })),
      });

      await expect(service.retryDeadLettered('evt-uuid-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // findOne()
  // -------------------------------------------------------------------------

  describe('findOne()', () => {
    it('returns the event document when found', async () => {
      const doc = makeEvent();
      eventModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      await expect(service.findOne('evt-uuid-1')).resolves.toBe(doc);
    });

    it('throws NotFoundException when event does not exist', async () => {
      eventModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
