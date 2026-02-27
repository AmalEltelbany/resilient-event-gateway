import { Type } from 'class-transformer';
import {
    IsDate,
    IsNotEmpty,
    IsObject,
    IsString,
    IsUUID,
    registerDecorator,
    ValidationArguments,
    ValidationOptions,
} from 'class-validator';

function HasShipmentId(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'hasShipmentId',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          return (
            typeof value === 'object' &&
            value !== null &&
            typeof (value as Record<string, unknown>)['shipmentId'] === 'string' &&
            ((value as Record<string, unknown>)['shipmentId'] as string).length > 0
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property}.shipmentId must be a non-empty string`;
        },
      },
    });
  };
}

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

  // @IsObject() rejects non-object values (strings, arrays, null).
  // @HasShipmentId() validates shipmentId without using @ValidateNested(),
  // so class-transformer never converts payload to a typed class and the
  // ValidationPipe whitelist never strips extra payload fields.
  @IsObject()
  @HasShipmentId()
  payload: Record<string, unknown>;
}
