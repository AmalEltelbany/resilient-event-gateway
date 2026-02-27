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
  private readonly replayWindowMs: number;

  constructor(private readonly config: ConfigService) {
    this.secret = this.config.get<string>('webhook.secret')!;
    this.replayWindowMs = this.config.get<number>('webhook.replayWindowMs')!;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const signature = req.headers['x-signature'] as string | undefined;

    if (!signature) {
      this.logger.warn('Missing x-signature header');
      throw new UnauthorizedException('Missing x-signature header');
    }

    const rawBody = req.rawBody;
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

    // Timestamp check runs AFTER signature validation so unauthenticated requests
    // never reach JSON.parse. Set WEBHOOK_REPLAY_WINDOW_MS=0 to disable.
    if (this.replayWindowMs > 0) {
      this.validateTimestamp(rawBody, req);
    }

    return true;
  }

  private validateTimestamp(rawBody: Buffer, req: Request): void {
    let timestamp: Date;
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      timestamp = new Date(body['timestamp'] as string);
      if (isNaN(timestamp.getTime())) {
        throw new Error('invalid date');
      }
    } catch {
      this.logger.warn(`Could not parse timestamp from request body: ${req.url}`);
      throw new UnauthorizedException('Invalid or missing timestamp in request body');
    }

    const ageMs = Math.abs(Date.now() - timestamp.getTime());
    if (ageMs > this.replayWindowMs) {
      this.logger.warn(
        `Request timestamp outside replay window (age: ${ageMs}ms, window: ${this.replayWindowMs}ms): ${req.url}`,
      );
      throw new UnauthorizedException('Request timestamp outside allowed window');
    }
  }
}
