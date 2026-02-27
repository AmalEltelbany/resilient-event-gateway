import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { HmacGuard } from '../infrastructure/guards/hmac.guard.js';
import { ApiKeyGuard } from '../infrastructure/guards/api-key.guard.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { PaginationQueryDto } from './dto/pagination-query.dto.js';
import { EventsService } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  // Ingestion endpoint: stricter rate limit than the global default.
  // 60 requests per minute per IP — a legitimate producer batching events
  // should never approach this; it catches runaway clients and replay attacks.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(HmacGuard)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  create(@Body() dto: CreateEventDto) {
    return this.eventsService.create(dto);
  }

  // Read endpoints: inherit the global default (200 req/min).
  @Get()
  @UseGuards(ApiKeyGuard)
  findAll(@Query() query: PaginationQueryDto) {
    return this.eventsService.findAll(query);
  }

  @Get(':eventId')
  @UseGuards(ApiKeyGuard)
  findOne(@Param('eventId') eventId: string) {
    return this.eventsService.findOne(eventId);
  }

  // Manual retry: tight limit — this is an operator action, not a hot path.
  @Post(':eventId/retry')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  retry(@Param('eventId') eventId: string) {
    return this.eventsService.retryDeadLettered(eventId);
  }
}
