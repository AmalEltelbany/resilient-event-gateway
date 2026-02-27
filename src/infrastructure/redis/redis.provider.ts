import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

// Wraps ioredis so NestJS shutdown hooks can close the connection cleanly.
export class RedisClientManager implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisClientManager.name);
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis({
      host: config.get<string>('redis.host'),
      port: config.get<number>('redis.port'),
      password: config.get<string>('redis.password'),
      lazyConnect: false,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing Redis connection…');
    await this.client.quit();
  }
}

export const RedisProvider = {
  provide: REDIS_CLIENT,
  inject: [RedisClientManager],
  useFactory: (manager: RedisClientManager): Redis => manager.client,
};
