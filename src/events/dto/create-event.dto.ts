import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { EventPayloadDto } from './event-payload.dto.js';

export class CreateEventDto {
  @IsUUID()
  eventId: string;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsString()
  @IsNotEmpty()
  source: string;

  @IsISO8601({ strict: true })
  timestamp: string;

  @ValidateNested()
  @Type(() => EventPayloadDto)
  payload: EventPayloadDto;
}
