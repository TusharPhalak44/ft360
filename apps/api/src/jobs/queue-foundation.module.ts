import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { APP_CONFIG, type AppEnvConfig } from '../config/env.config';
import {
  FoundationCanaryProcessor,
  SYSTEM_MAINTENANCE_QUEUE,
} from './foundation-canary.processor';

export { SYSTEM_MAINTENANCE_QUEUE } from './foundation-canary.processor';

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
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      }),
    }),
    BullModule.registerQueue({
      name: SYSTEM_MAINTENANCE_QUEUE,
    }),
  ],
  providers: [FoundationCanaryProcessor],
  exports: [BullModule],
})
export class QueueFoundationModule {}
