import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, RedisClientManager, RedisProvider } from './redis.provider.js';

@Global()
@Module({
  providers: [
    {
      provide: RedisClientManager,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new RedisClientManager(config),
    },
    RedisProvider,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
