import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CacheModule } from './cache/cache.module';
import { CorrelationIdInterceptor } from './common/correlation-id.interceptor';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { UntrustedTenantInputGuard } from './common/untrusted-tenant-input.guard';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueFoundationModule } from './jobs/queue-foundation.module';
import { BrandingModule } from './modules/branding/branding.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    CacheModule,
    QueueFoundationModule,
    BrandingModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UntrustedTenantInputGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CorrelationIdInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}

