import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { HmacGuard } from '../infrastructure/guards/hmac.guard.js';
import { ApiKeyGuard } from '../infrastructure/guards/api-key.guard.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { PaginationQueryDto } from './dto/pagination-query.dto.js';
import { EventsService } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(HmacGuard)
  create(@Body() dto: CreateEventDto) {
    return this.eventsService.create(dto);
  }

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

  @Post(':eventId/retry')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  retry(@Param('eventId') eventId: string) {
    return this.eventsService.retryDeadLettered(eventId);
  }
}
