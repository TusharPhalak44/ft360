import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { CsrfProtectionGuard } from '../../common/csrf-protection.guard';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { PlatformSuperAdminGuard } from '../../common/platform-super-admin.guard';
import { TenantAdminGuard } from '../../common/tenant-admin.guard';
import { FoundationDbModule } from '../foundation-db/foundation-db.module';
import { AuthAuditService } from './auth-audit.service';
import { AuthController } from './auth.controller';
import {
  AUTH_TRANSACTIONAL_MAIL_QUEUE,
  AuthMailOutboxService,
  AuthTransactionalMailProcessor,
} from './auth-mail-outbox.service';
import { AUTH_MAIL_PROVIDER, ConfiguredAuthMailProvider } from './auth-mail-provider';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { BootstrapSuperAdminService } from './bootstrap-super-admin.service';
import { PasswordHashService } from './password-hash.service';
import { RedisSessionCacheService } from './session-cache.service';
import { TokenService } from './token.service';

@Global()
@Module({
  imports: [
    FoundationDbModule,
    BullModule.registerQueue({
      name: AUTH_TRANSACTIONAL_MAIL_QUEUE,
    }),
  ],
  controllers: [AuthController],
  providers: [
    PasswordHashService,
    TokenService,
    RedisSessionCacheService,
    AuthRateLimitService,
    AuthRepository,
    AuthAuditService,
    ConfiguredAuthMailProvider,
    {
      provide: AUTH_MAIL_PROVIDER,
      useExisting: ConfiguredAuthMailProvider,
    },
    AuthMailOutboxService,
    AuthTransactionalMailProcessor,
    AuthService,
    BootstrapSuperAdminService,
    JwtAuthGuard,
    CsrfProtectionGuard,
    PlatformSuperAdminGuard,
    TenantAdminGuard,
  ],
  exports: [
    PasswordHashService,
    TokenService,
    RedisSessionCacheService,
    AuthRateLimitService,
    AuthRepository,
    AuthAuditService,
    AUTH_MAIL_PROVIDER,
    ConfiguredAuthMailProvider,
    AuthMailOutboxService,
    AuthService,
    BootstrapSuperAdminService,
    JwtAuthGuard,
    CsrfProtectionGuard,
    PlatformSuperAdminGuard,
    TenantAdminGuard,
  ],
})
export class AuthModule {}
