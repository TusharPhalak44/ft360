import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CacheModule } from './cache/cache.module';
import { CorrelationIdInterceptor } from './common/correlation-id.interceptor';
import { CsrfProtectionGuard } from './common/csrf-protection.guard';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { UntrustedTenantInputGuard } from './common/untrusted-tenant-input.guard';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { QueueFoundationModule } from './jobs/queue-foundation.module';
import { AuthModule } from './modules/auth/auth.module';
import { BrandingModule } from './modules/branding/branding.module';
import { FoundationDbModule } from './modules/foundation-db/foundation-db.module';
import { HealthModule } from './modules/health/health.module';
import { PlatformBoundaryModule } from './modules/platform-boundary/platform-boundary.module';
import { WorkspaceBoundaryModule } from './modules/workspace-boundary/workspace-boundary.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    CacheModule,
    QueueFoundationModule,
    FoundationDbModule,
    AuthModule,
    BrandingModule,
    HealthModule,
    WorkspaceBoundaryModule,
    PlatformBoundaryModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UntrustedTenantInputGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CsrfProtectionGuard,
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
