import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from './config/configuration.js';
import { RedisModule } from './common/redis/redis.module.js';
import { EventsModule } from './events/events.module.js';
import { ShipmentsModule } from './shipments/shipments.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),

    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongo.uri'),
      }),
    }),

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

    RedisModule,
    EventsModule,
    ShipmentsModule,
  ],
})
export class AppModule {}
