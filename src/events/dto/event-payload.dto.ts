import { IsString, IsNotEmpty } from 'class-validator';

export class EventPayloadDto {
  @IsString()
  @IsNotEmpty()
  shipmentId: string;

  // Open-schema: allow arbitrary extra fields in the payload so producers can
  // include carrier-specific metadata without the gateway rejecting the request.
  //
  // Trade-off: the index signature opts this class out of class-validator's
  // whitelist check for nested properties — forbidNonWhitelisted on the parent
  // CreateEventDto does NOT propagate into EventPayloadDto. Only `shipmentId`
  // is validated; all other payload fields are passed through and stored as-is
  // in MongoDB. This is intentional: the worker only reads `shipmentId`, and
  // the open schema makes the gateway extensible without requiring DTO changes
  // every time a new carrier-specific field is introduced.
  [key: string]: unknown;
}
