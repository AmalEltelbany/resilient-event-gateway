import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Event, EventStatus } from './schemas/event.schema.js';
import { EventsService } from './events.service.js';
import { EVENT_QUEUE } from './events.constants.js';
import { REDIS_CLIENT } from '../infrastructure/redis/redis.provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDto(overrides = {}) {
  return {
    eventId: 'evt-uuid-1',
    type: 'shipment.status_updated',
    source: 'fedex',
    timestamp: '2026-01-01T00:00:00.000Z',
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
    timestamp: '2026-01-01T00:00:00.000Z',
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
  let eventQueue: any;
  let redis: any;

  beforeEach(async () => {
    eventModel = {
      create: jest.fn(),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 0 }) }),
      findOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }) }) }),
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
    it('enqueues the job then persists to MongoDB on the happy path', async () => {
      const dto = makeDto();
      const doc = makeEvent();
      eventModel.create.mockResolvedValue(doc);

      const result = await service.create(dto);

      // Enqueue must happen BEFORE create (ghost-event ordering guarantee)
      const enqueueOrder = eventQueue.add.mock.invocationCallOrder[0];
      const persistOrder = eventModel.create.mock.invocationCallOrder[0];
      expect(enqueueOrder).toBeLessThan(persistOrder);

      expect(eventQueue.add).toHaveBeenCalledWith(
        dto.type,
        expect.objectContaining({ eventId: dto.eventId }),
        { jobId: dto.eventId },
      );
      expect(result).toEqual({ status: 'accepted', eventId: dto.eventId });
    });

    it('throws ConflictException when Redis SET NX returns null (duplicate)', async () => {
      redis.set.mockResolvedValue(null);
      await expect(service.create(makeDto())).rejects.toBeInstanceOf(ConflictException);
      expect(eventQueue.add).not.toHaveBeenCalled();
    });

    it('degrades gracefully when Redis throws — falls through to DB layer', async () => {
      redis.set.mockRejectedValue(new Error('Redis connection refused'));
      eventModel.create.mockResolvedValue(makeEvent());

      // Should NOT throw — Redis failure is non-fatal
      await expect(service.create(makeDto())).resolves.toMatchObject({ status: 'accepted' });
      expect(eventQueue.add).toHaveBeenCalled();
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
