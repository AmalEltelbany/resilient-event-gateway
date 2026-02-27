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

### Task 9 — Redis Idempotency Check in EventsService

**Prompt:** In `EventsService.create()`, before saving to MongoDB, add a Redis idempotency check.
**Result:**

- Created `src/common/redis/redis.provider.ts` — `REDIS_CLIENT` injection token + `RedisProvider` factory (builds `ioredis` `Redis` instance from `ConfigService`)
- Created `src/common/redis/redis.module.ts` — `@Global()` module exporting `REDIS_CLIENT` so any module can inject without re-importing
- Registered `RedisModule` in `AppModule`
- Updated `EventsService.create()`:
  - Injects `@Inject(REDIS_CLIENT) redis: Redis`
  - Before any DB or queue call: `redis.set('idempotency:event:<eventId>', '1', 'EX', 86400, 'NX')`
  - `SET NX EX` is atomic — returns `'OK'` on first call, `null` on duplicate
  - On `null`: logs warning, throws `ConflictException` (HTTP 409) — no MongoDB write, no queue enqueue
  - TTL is 24 h (covers max retry window); constant `IDEMPOTENCY_PREFIX` for key namespacing
- Build passes cleanly

---

### Task 10 — DLQ Retry Endpoint

**Prompt:** Add a DLQ retry endpoint so dead-lettered events can be recovered instead of just logged. Without this, the DLQ is a graveyard operations teams need a way to re-enqueue failed events after fixing the root cause.
**Result:**

- Added `POST /api/events/:eventId/retry` endpoint in `EventsController` with `ApiKeyGuard`
- Added `retryDeadLettered(eventId)` method in `EventsService`:
  - Finds event by `eventId`, verifies status is `dead_lettered` (returns 404 if not found, 400 if wrong status)
  - Resets status to `pending`, clears `errorMessage`, resets `attempts` to 0
  - Re-enqueues to main `events` queue with unique jobId (`retry:<eventId>:<timestamp>`)
  - Returns `{ status: 'requeued', eventId }`
- Build passes cleanly

---

### Task 11 — Cursor-Based Pagination

**Prompt:** Add cursor-based pagination to `GET /api/events`. The current `findAll()` returns every event — with 100k+ records this will OOM the process. Use cursor pagination with MongoDB `_id` descending, accept `limit` (default 20, max 100) and `cursor` query params.
**Result:**

- Created `src/events/dto/pagination-query.dto.ts` — validated DTO with `@IsOptional() @IsInt() @Min(1) @Max(100) limit` and `@IsOptional() @IsString() cursor`
- Updated `EventsService.findAll()` to accept `PaginationQueryDto`:
  - If `cursor` provided: filters `{ _id: { $lt: cursor } }` (fetch next page)
  - Sorts by `_id` descending (newest first)
  - Fetches `limit + 1` to determine if more pages exist
  - Returns `{ data, nextCursor, hasMore }`
- Updated `EventsController.findAll()` with `@Query()` decorator
- Build passes cleanly

---

## Architectural Decision Prompts

These prompts were used to reason through the core design decisions of the system before and during implementation.

---

### Decision 1 — Why BullMQ over a simple in-memory queue?

**Prompt:** I need to handle high-volume event bursts without blocking the ingestion layer. What are the trade-offs between an in-memory queue, a Redis-backed queue like BullMQ, and a full message broker like RabbitMQ or Kafka for a NestJS service?

**Decision taken:** BullMQ backed by Redis.

- In-memory queues lose all jobs on process crash — unacceptable for a resilience-focused system
- Kafka/RabbitMQ add operational overhead that is disproportionate for a single-service gateway
- BullMQ gives persistent jobs, built-in retry with exponential backoff, DLQ pattern, concurrency control, and a NestJS-native integration — all with Redis as the only infrastructure dependency we already need for idempotency

---

### Decision 2 — How should idempotency be enforced for duplicate events?

**Prompt:** Duplicate events are common in logistics systems. What is the most robust way to guarantee exactly-once processing in a NestJS + BullMQ + MongoDB stack? What are the failure modes of each approach?

**Decision taken:** Three-layer defense in depth.

1. **Redis `SET NX EX`** — atomic, sub-millisecond check at ingestion time; rejects duplicates before any DB write; TTL of 24h covers the full retry window
2. **MongoDB unique index on `eventId`** — backstop if Redis is unavailable; the DB write itself will throw a duplicate key error
3. **BullMQ `jobId` deduplication** — if somehow both Redis and MongoDB are bypassed, BullMQ will not enqueue a second job with the same `jobId`

Each layer independently prevents double-processing; together they handle Redis downtime, race conditions, and replay attacks.

---

### Decision 3 — What retry strategy should be used for the Routing Service?

**Prompt:** The Routing Service has a simulated 20% failure rate and a 2-second latency. What retry strategy should I configure in BullMQ to handle transient failures without hammering the service or exhausting workers?

**Decision taken:** Exponential backoff with 3 attempts.

- **Exponential backoff** (base delay 3000ms): retries at ~3s, ~6s, ~12s — gives the routing service time to recover between attempts without a fixed retry storm
- **3 attempts**: balances resilience against indefinite retries; after 3 failures the event is genuinely broken and should go to DLQ for manual inspection
- **Configurable via env** (`QUEUE_JOB_ATTEMPTS`, `QUEUE_BACKOFF_DELAY_MS`): allows tuning per environment without code changes

---

### Decision 4 — What should happen to events that exhaust all retries?

**Prompt:** After a job fails all retry attempts, what are the options? Should I just mark it failed in MongoDB, drop it, or implement a Dead Letter Queue? What does a DLQ give me that a simple failure status does not?

**Decision taken:** Dedicated `events-dlq` BullMQ queue with a `DlqProcessor` and a manual retry endpoint.

- A `FAILED` status with no recovery path is a dead end — operations teams cannot act on it
- A DLQ queue gives observability (you can inspect failed jobs in Redis), auditability (MongoDB `dead_lettered` status with `errorMessage`), and recoverability (`POST /api/events/:eventId/retry` re-enqueues after the root cause is fixed)
- Separate DLQ concurrency (5 workers vs 10 for main queue) ensures DLQ processing never competes with live traffic

---

### Decision 5 — How should the ingestion endpoint stay under 150ms?

**Prompt:** The assessment requires the ingestion handshake to be under 150ms. The Routing Service has a 2-second delay. How do I structure the controller and processor so the HTTP response is decoupled from the processing time?

**Decision taken:** Thin controller returning `202 Accepted` immediately after enqueue.

- `POST /api/events` does only three things synchronously: validate HMAC, validate DTO, enqueue to BullMQ
- The controller returns `{ status: 'accepted', eventId }` as soon as the job is in the queue — before any MongoDB write in the processor, before any routing call
- All heavy work (shipment lookup, routing service call, status updates) happens asynchronously in `EventProcessor` workers
- This keeps the ingestion path at network + HMAC compute + Redis enqueue latency, well under 150ms

---

### Decision 6 — Why cursor-based pagination instead of offset pagination?

**Prompt:** The events collection will grow unboundedly. What are the performance trade-offs between `SKIP/LIMIT` offset pagination and cursor-based pagination in MongoDB at scale?

**Decision taken:** Cursor-based pagination using `_id` as the cursor.

- `SKIP N` requires MongoDB to scan and discard N documents — at 100k+ records, page 500 requires scanning 10,000 documents just to skip them
- `_id`-based cursor uses the default index (`_id` is always indexed) — fetching page N is O(1) regardless of collection size
- `_id` is monotonically increasing so sorting descending gives newest-first naturally with no additional index needed
- Trade-off: no random page access (cannot jump to page 50) — acceptable for an event log where consumers read sequentially

---

### Decision 7 — Why HMAC on ingestion and API key on read endpoints?

**Prompt:** The assessment requires securing the ingestion endpoint. Should all endpoints use the same auth mechanism? What is the right security model for a webhook-style gateway vs an internal read API?

**Decision taken:** HMAC on `POST /api/events`, API key on all other endpoints.

- **HMAC** (`x-signature: sha256=<hex>`) proves the payload was signed by a party holding the shared secret — it authenticates both the sender identity and the payload integrity; ideal for webhook-style ingestion from external producers
- **API key** (`x-api-key`) is simpler and appropriate for internal consumers (dashboards, ops tooling) reading event state — they don't need to sign payloads, just authenticate themselves
- Both use `crypto.timingSafeEqual()` to prevent timing-based brute-force attacks on the secrets
