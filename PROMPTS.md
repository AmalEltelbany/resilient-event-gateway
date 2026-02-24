# PROMPTS.md

Session log for the `resilient-event-gateway` NestJS project.
Updated after each completed task.

---

## Session: 2026-02-24

### Task 1 — Session Setup
**Prompt:** Create a PROMPTS.md file and keep it updated after every task we complete throughout this session.
**Result:** Created this file. Project is a fresh NestJS scaffold (`resilient-event-gateway`) with no custom source code yet.

---

### Task 2 — Project Scaffold
**Prompt:** Scaffold the project structure. Stack: NestJS, Mongoose, BullMQ, ioredis. Create folder structure, docker-compose with Redis and MongoDB, .env file.
**Result:**
- Installed packages: `@nestjs/mongoose`, `mongoose`, `@nestjs/bullmq`, `bullmq`, `ioredis`, `@nestjs/config`
- Created folder structure:
  - `src/config/` — `configuration.ts` (typed config factory)
  - `src/events/dto/` — `create-event.dto.ts`
  - `src/events/schemas/` — `event.schema.ts` (Mongoose schema with status enum)
  - `src/events/processors/` — `event.processor.ts` (BullMQ `WorkerHost`)
  - `src/events/consumers/` — (reserved for future consumers)
  - `src/events/` — `events.service.ts`, `events.controller.ts`, `events.module.ts`
  - `src/queues/` — `queue.constants.ts`
  - `src/common/filters/` — `all-exceptions.filter.ts`
  - `src/common/interceptors/`, `src/common/decorators/` — (reserved)
- Created `docker-compose.yml` with MongoDB 7, Redis 7-alpine, optional Redis Commander (profile: `tools`)
- Created `.env` and `.env.example`
- Wired `AppModule` with `ConfigModule` (global), `MongooseModule.forRootAsync`, `BullModule.forRootAsync`
- Updated `main.ts`: global prefix `/api`, global exception filter, shutdown hooks
- Build passes cleanly (`npm run build`)

---

### Task 3 — CreateEventDto Validation
**Prompt:** Implement CreateEventDto with full validation using class-validator and class-transformer. Fields: `eventId` (UUID), `type` (string, not empty), `source` (string, not empty), `timestamp` (ISO8601), `payload` (nested object with required `shipmentId`). Apply ValidationPipe globally.
**Result:**
- Installed `class-validator` and `class-transformer`
- Created `src/events/dto/event-payload.dto.ts` — nested DTO with `@IsString() @IsNotEmpty() shipmentId`; allows extra fields via index signature
- Replaced `src/events/dto/create-event.dto.ts` with fully validated DTO:
  - `eventId` → `@IsUUID()`
  - `type` → `@IsString() @IsNotEmpty()`
  - `source` → `@IsString() @IsNotEmpty()`
  - `timestamp` → `@IsISO8601({ strict: true })`
  - `payload` → `@ValidateNested() @Type(() => EventPayloadDto)`
- Updated `EventsService.create()` to use all new DTO fields when persisting and enqueuing
- Added `ValidationPipe` globally in `main.ts` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
- Build passes cleanly

---

### Task 4 — HMAC Signature Guard
**Prompt:** Add HMAC signature validation guard on `POST /api/events`.
**Result:**
- Created `src/common/guards/hmac.guard.ts` — `HmacGuard` implementing `CanActivate`:
  - Reads `x-signature` request header (format: `sha256=<hex>`)
  - Reads raw body via NestJS built-in `rawBody` (enabled with `rawBody: true` on factory)
  - Computes `HMAC-SHA256` of raw body using `WEBHOOK_SECRET`
  - Uses `timingSafeEqual` to prevent timing attacks; throws `401` on any mismatch or missing header
- Added `rawBody: true` to `NestFactory.create()` in `main.ts`
- Added `webhook.secret` key to `src/config/configuration.ts`; throws on startup if secret is absent
- Added `WEBHOOK_SECRET` to `.env` and `.env.example`
- Applied `@UseGuards(HmacGuard)` to `@Post()` in `EventsController`
- Registered `HmacGuard` as a provider in `EventsModule`
- Build passes cleanly

---

### Task 5 — Shipments Module
**Prompt:** Add a shipments module. Schema fields: `shipmentId` (unique), `merchantId`, `status` (pending/in_transit/delivered/delayed), `carrier`, `origin`, `destination`. One service method: `findByShipmentId`. Seed 10 shipments on startup with IDs `ship-1` to `ship-10` and mixed statuses.
**Result:**
- Created `src/shipments/shipment.schema.ts` — Mongoose schema with `ShipmentStatus` enum (`pending`, `in_transit`, `delivered`, `delayed`); `shipmentId` is unique-indexed
- Created `src/shipments/shipments.service.ts` — `ShipmentsService` with `findByShipmentId(shipmentId)` throwing `NotFoundException` if not found
- Created `src/shipments/shipment-seed.service.ts` — `ShipmentSeedService` implementing `OnApplicationBootstrap`; uses `$setOnInsert` upserts so re-runs are idempotent; seeds 10 documents with IDs `ship-1`…`ship-10`, mixed statuses (`pending` ×2, `in_transit` ×4, `delivered` ×2, `delayed` ×2), rotating carriers (FedEx/UPS/DHL/USPS/OnTrac) and cities
- Created `src/shipments/shipments.module.ts` — registers schema, provides both services, exports `ShipmentsService`
- Registered `ShipmentsModule` in `AppModule`
- Build passes cleanly

---

### Task 6 — Event Processor Implementation
**Prompt:** Implement `EventProcessor` with concurrency 10. Add `RoutingService` (2s delay, 20% random failure). In `process()`: skip if already completed, update status to `processing`, fetch shipment via `ShipmentsService`, call routing service, on success update status to `completed` and set `processedAt`.
**Result:**
- Created `src/events/routing.service.ts` — `RoutingService` with `route(shipment, eventType)`: 2 s `setTimeout` delay, then `Math.random() < 0.2` throws `Error` (20% failure rate), otherwise logs success
- Replaced `src/events/processors/event.processor.ts` with full implementation:
  - `@Processor(EVENT_QUEUE, { concurrency: 10 })` — 10 parallel workers
  - Injects `EventModel`, `ShipmentsService`, `RoutingService`
  - Step 1: idempotency guard — `findOne({ eventId })`, return early if `status === COMPLETED`
  - Step 2: `$set { status: PROCESSING }` + `$inc { attempts: 1 }`
  - Step 3: `shipmentsService.findByShipmentId(payload.shipmentId)`
  - Step 4: `routingService.route(shipment, job.name)` — throws on failure, BullMQ retries with exponential backoff
  - Step 5: `$set { status: COMPLETED, processedAt: new Date(), errorMessage: null }`
- Updated `EventsModule`: imported `ShipmentsModule`, added `RoutingService` to providers
- Build passes cleanly

---

### Task 7 — Dead Letter Queue (DLQ)
**Prompt:** Add DLQ support to the event processor.
**Result:**
- Added `EVENT_DLQ = 'events:dlq'` constant to `src/queues/queue.constants.ts`
- Added `@OnWorkerEvent('failed')` handler to `EventProcessor`:
  - Returns early if `job.attemptsMade < maxAttempts` (still has retries)
  - When all retries exhausted: enqueues job data + `{ originalJobId, failedReason }` onto `EVENT_DLQ` with stable `jobId: dlq:<id>`
  - Injects `@InjectQueue(EVENT_DLQ)` into the processor
- Created `src/events/processors/dlq.processor.ts` — `DlqProcessor`:
  - `@Processor(EVENT_DLQ, { concurrency: 5 })`
  - Reads `{ eventId, failedReason, originalJobId }` from job data
  - Sets MongoDB document `status = dead_lettered`, `errorMessage = failedReason`
- Updated `EventsModule`: registered `BullModule.registerQueue({ name: EVENT_DLQ })`, added `DlqProcessor` to providers
- Build passes cleanly

**Flow:**
```
process() throws → BullMQ retries (exponential backoff, up to 3 attempts)
  → all attempts exhausted → onFailed() fires
    → job moved to events-dlq
      → DlqProcessor.process() → MongoDB status = dead_lettered
```

---

### Task 8 — Dockerfile + Docker Compose App Service
**Prompt:** Add a Dockerfile and wire the app as a service in docker-compose. Multi-stage build. In docker-compose add app service depending on mongodb and redis.
**Result:**
- Created `Dockerfile` with two stages:
  - `builder`: `node:22-alpine`, `npm ci`, `npm run build` → produces `dist/`
  - `production`: `node:22-alpine`, `npm ci --omit=dev`, copies `dist/` from builder, `CMD ["node", "dist/main"]`
- Created `.dockerignore` — excludes `node_modules`, `dist`, `.env`, `.git`
- Updated `docker-compose.yml` — added `app` service:
  - Builds from local Dockerfile
  - `env_file: .env` + overrides `MONGO_URI` and `REDIS_HOST` to use container hostnames (`mongodb`, `redis`)
  - `depends_on: mongodb, redis`
  - Exposes port 3000, joins `reg_network`

---
