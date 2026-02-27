import { Type } from 'class-transformer';
import {
    IsDate,
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

  @Type(() => Date)
  @IsDate()
  timestamp: Date;

  @ValidateNested()
  @Type(() => EventPayloadDto)
  payload: EventPayloadDto;
}
