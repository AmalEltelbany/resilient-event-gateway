import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class HmacGuard implements CanActivate {
  private readonly logger = new Logger(HmacGuard.name);
  private readonly secret: string;

  constructor(private readonly config: ConfigService) {
    this.secret = this.config.get<string>('webhook.secret')!;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const signature = req.headers['x-signature'] as string | undefined;

    if (!signature) {
      this.logger.warn('Missing x-signature header');
      throw new UnauthorizedException('Missing x-signature header');
    }

    const rawBody = (req as any).rawBody as Buffer | undefined;
    if (!rawBody) {
      this.logger.warn('Raw body unavailable for HMAC validation');
      throw new UnauthorizedException('Unable to verify request signature');
    }

    const expected = `sha256=${createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('hex')}`;

    let incoming: Buffer;
    let expectedBuf: Buffer;
    try {
      incoming = Buffer.from(signature, 'utf8');
      expectedBuf = Buffer.from(expected, 'utf8');
    } catch {
      throw new UnauthorizedException('Invalid signature format');
    }

    if (
      incoming.length !== expectedBuf.length ||
      !timingSafeEqual(incoming, expectedBuf)
    ) {
      this.logger.warn(`HMAC mismatch for ${req.method} ${req.url}`);
      throw new UnauthorizedException('Invalid request signature');
    }

    return true;
  }
}
