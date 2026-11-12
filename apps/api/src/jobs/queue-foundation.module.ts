import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_CONFIG, type AppEnvConfig } from '../config/env.config';

export const SYSTEM_MAINTENANCE_QUEUE = 'system-maintenance';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppEnvConfig) => ({
        connection: {
          host: config.redis.host,
          port: config.redis.port,
          password: config.redis.password,
          db: config.redis.queueDb,
          lazyConnect: true,
          retryStrategy: (times: number) => Math.min(times * 2000, 15000),
        },
        prefix: 'ft360:q',
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      }),
    }),
    BullModule.registerQueue({
      name: SYSTEM_MAINTENANCE_QUEUE,
    }),
  ],
  exports: [BullModule],
})
export class QueueFoundationModule {}

