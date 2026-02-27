import { createHmac } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import supertest from 'supertest';
import { AllExceptionsFilter } from '../src/infrastructure/filters/all-exceptions.filter.js';
import { EventsController } from '../src/events/events.controller.js';
import { EventsService } from '../src/events/events.service.js';
import { HmacGuard } from '../src/infrastructure/guards/hmac.guard.js';
import { ApiKeyGuard } from '../src/infrastructure/guards/api-key.guard.js';
import { EventStatus } from '../src/events/schemas/event.schema.js';

// ---------------------------------------------------------------------------
// Constants shared between tests
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'test-secret';
const API_KEY = 'test-api-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: '550e8400-e29b-41d4-a716-446655440000',
    type: 'shipment.status_updated',
    source: 'fedex',
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { shipmentId: 'ship-1' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test module — wires real guards/pipes/filters, mocks only EventsService
// ---------------------------------------------------------------------------

describe('EventsController (e2e)', () => {
  let app: INestApplication;
  let eventsService: jest.Mocked<Partial<EventsService>>;

  beforeAll(async () => {
    process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.API_KEY = API_KEY;

    eventsService = {
      create: jest.fn().mockResolvedValue({ status: 'accepted', eventId: '550e8400-e29b-41d4-a716-446655440000' }),
      findOne: jest.fn().mockResolvedValue(undefined),
      findAll: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
      retryDeadLettered: jest.fn().mockResolvedValue({ status: 'requeued', eventId: '550e8400-e29b-41d4-a716-446655440000' }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => ({
            apiKey: API_KEY,
            webhook: { secret: WEBHOOK_SECRET },
            throttle: { ttlMs: 60_000, limit: 200 },
          })],
        }),
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }] }),
      ],
      controllers: [EventsController],
      providers: [
        { provide: EventsService, useValue: eventsService },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        HmacGuard,
        ApiKeyGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    (app as NestExpressApplication).useBodyParser('json', { limit: '256kb' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    eventsService.create!.mockResolvedValue({ status: 'accepted', eventId: '550e8400-e29b-41d4-a716-446655440000' });
    eventsService.findOne!.mockResolvedValue(undefined as any);
    eventsService.retryDeadLettered!.mockResolvedValue({ status: 'requeued', eventId: '550e8400-e29b-41d4-a716-446655440000' });
  });

  // -------------------------------------------------------------------------
  // POST /api/events — ingestion
  // -------------------------------------------------------------------------

  describe('POST /api/events', () => {
    it('returns 202 with { status, eventId } on valid signed request', async () => {
      const body = validBody();
      const bodyStr = JSON.stringify(body);

      await supertest(app.getHttpServer())
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .set('x-signature', sign(bodyStr))
        .send(bodyStr)
        .expect(202)
        .expect(({ body: res }) => {
          expect(res.status).toBe('accepted');
          expect(res.eventId).toBe('550e8400-e29b-41d4-a716-446655440000');
        });

      expect(eventsService.create).toHaveBeenCalledTimes(1);
    });

    it('returns 401 when x-signature header is missing', async () => {
      const body = validBody();

      await supertest(app.getHttpServer())
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(401)
        .expect(({ body: res }) => {
          // AllExceptionsFilter returns the raw NestJS exception response as `message`
          // in non-production. For HttpExceptions that raw value is an object with
          // { statusCode, message, error }. We stringify to assert the error text.
          expect(JSON.stringify(res)).toMatch(/Missing x-signature/i);
        });

      expect(eventsService.create).not.toHaveBeenCalled();
    });

    it('returns 401 when HMAC signature is invalid', async () => {
      const body = validBody();
      const bodyStr = JSON.stringify(body);

      await supertest(app.getHttpServer())
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .set('x-signature', 'sha256=badsignature')
        .send(bodyStr)
        .expect(401)
        .expect(({ body: res }) => {
          expect(JSON.stringify(res)).toMatch(/Invalid request signature/i);
        });

      expect(eventsService.create).not.toHaveBeenCalled();
    });

    it('returns 409 when service throws ConflictException (duplicate eventId)', async () => {
      eventsService.create!.mockRejectedValue(
        new ConflictException('Event 550e8400-e29b-41d4-a716-446655440000 has already been received'),
      );

      const body = validBody();
      const bodyStr = JSON.stringify(body);

      await supertest(app.getHttpServer())
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .set('x-signature', sign(bodyStr))
        .send(bodyStr)
        .expect(409);
    });

    it('returns 400 when eventId is not a UUID', async () => {
      const body = validBody({ eventId: 'not-a-uuid' });
      const bodyStr = JSON.stringify(body);

      await supertest(app.getHttpServer())
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .set('x-signature', sign(bodyStr))
        .send(bodyStr)
        .expect(400);

      expect(eventsService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when required field is missing', async () => {
      const { type: _omit, ...bodyWithoutType } = validBody() as any;
      const bodyStr = JSON.stringify(bodyWithoutType);

      await supertest(app.getHttpServer())
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .set('x-signature', sign(bodyStr))
        .send(bodyStr)
        .expect(400);

      expect(eventsService.create).not.toHaveBeenCalled();
    });

    it('returns 400 when timestamp is not a valid date string', async () => {
      const body = validBody({ timestamp: 'not-a-date' });
      const bodyStr = JSON.stringify(body);

      await supertest(app.getHttpServer())
        .post('/api/events')
        .set('Content-Type', 'application/json')
        .set('x-signature', sign(bodyStr))
        .send(bodyStr)
        .expect(400);

      expect(eventsService.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/events/:eventId
  // -------------------------------------------------------------------------

  describe('GET /api/events/:eventId', () => {
    it('returns 200 with the event document when found', async () => {
      const doc = {
        eventId: 'evt-uuid-1',
        type: 'shipment.status_updated',
        status: EventStatus.COMPLETED,
        source: 'fedex',
        attempts: 1,
      };
      eventsService.findOne!.mockResolvedValue(doc as any);

      await supertest(app.getHttpServer())
        .get('/api/events/evt-uuid-1')
        .set('x-api-key', API_KEY)
        .expect(200)
        .expect(({ body: res }) => {
          expect(res.eventId).toBe('evt-uuid-1');
          expect(res.status).toBe(EventStatus.COMPLETED);
        });
    });

    it('returns 404 when event does not exist', async () => {
      eventsService.findOne!.mockRejectedValue(new NotFoundException('Event missing not found'));

      await supertest(app.getHttpServer())
        .get('/api/events/missing')
        .set('x-api-key', API_KEY)
        .expect(404);
    });

    it('returns 401 when API key is missing', async () => {
      await supertest(app.getHttpServer())
        .get('/api/events/evt-uuid-1')
        .expect(401);

      expect(eventsService.findOne).not.toHaveBeenCalled();
    });

    it('returns 401 when API key is wrong', async () => {
      await supertest(app.getHttpServer())
        .get('/api/events/evt-uuid-1')
        .set('x-api-key', 'wrong-key')
        .expect(401);

      expect(eventsService.findOne).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/events/:eventId/retry
  // -------------------------------------------------------------------------

  describe('POST /api/events/:eventId/retry', () => {
    it('returns 200 with { status: requeued } on success', async () => {
      await supertest(app.getHttpServer())
        .post('/api/events/evt-uuid-1/retry')
        .set('x-api-key', API_KEY)
        .expect(200)
        .expect(({ body: res }) => {
          expect(res.status).toBe('requeued');
        });
    });

    it('returns 400 when event is not dead_lettered', async () => {
      eventsService.retryDeadLettered!.mockRejectedValue(
        new BadRequestException('Event evt-uuid-1 is not dead_lettered (current: completed)'),
      );

      await supertest(app.getHttpServer())
        .post('/api/events/evt-uuid-1/retry')
        .set('x-api-key', API_KEY)
        .expect(400);
    });

    it('returns 404 when event does not exist', async () => {
      eventsService.retryDeadLettered!.mockRejectedValue(
        new NotFoundException('Event missing not found'),
      );

      await supertest(app.getHttpServer())
        .post('/api/events/missing/retry')
        .set('x-api-key', API_KEY)
        .expect(404);
    });

    it('returns 401 when API key is missing', async () => {
      await supertest(app.getHttpServer())
        .post('/api/events/evt-uuid-1/retry')
        .expect(401);

      expect(eventsService.retryDeadLettered).not.toHaveBeenCalled();
    });
  });
});
