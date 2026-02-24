import { IsString, IsNotEmpty } from 'class-validator';

export class EventPayloadDto {
  @IsString()
  @IsNotEmpty()
  shipmentId: string;

  [key: string]: unknown;
}
