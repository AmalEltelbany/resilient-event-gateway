import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { HealthModule } from './health/health.module.js';
import { EventsModule } from './events/events.module.js';
import { ShipmentsModule } from './shipments/shipments.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        transport: process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
          : undefined,
        level: process.env.LOG_LEVEL ?? 'info',
      },
    }),

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongo.uri'),
      }),
    }),

    // BullMQ requires its own dedicated connection (uses blocking Redis commands
    // like BRPOP that cannot be shared). Both connections use the same config source.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          password: config.get<string>('redis.password'),
        },
        defaultJobOptions: {
          attempts: config.get<number>('queue.defaultJobAttempts'),
          backoff: {
            type: 'exponential',
            delay: config.get<number>('queue.defaultBackoffDelay'),
          },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      }),
    }),

    // Rate limiting — applied globally, with per-route overrides via @Throttle().
    // Uses in-memory storage (correct for single-instance).
    // For multi-instance deployments replace ThrottlerStorageService with a
    // Redis-backed store (e.g. @nest-lab/throttler-storage-redis) so counters
    // are shared across replicas and a single client can't bypass the limit by
    // round-robining between instances.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('throttle.ttlMs')!,
            limit: config.get<number>('throttle.limit')!,
          },
        ],
      }),
    }),

    // Outbox reconciliation — schedules the periodic stale-PENDING scan.
    ScheduleModule.forRoot(),

    RedisModule,
    HealthModule,
    EventsModule,
    ShipmentsModule,
  ],
})
export class AppModule {}
