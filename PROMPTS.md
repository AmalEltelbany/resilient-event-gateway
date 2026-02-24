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
