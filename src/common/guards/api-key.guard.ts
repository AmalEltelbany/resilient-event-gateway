import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('apiKey')!;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = req.headers['x-api-key'] as string | undefined;
    if (!key) {
      throw new UnauthorizedException('Missing API key');
    }

    const incoming = Buffer.from(key, 'utf8');
    const expected = Buffer.from(this.apiKey, 'utf8');
    if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
