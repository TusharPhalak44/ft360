import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { FoundationDbModule } from '../foundation-db/foundation-db.module';
import { TenantAuditModule } from '../tenant-audit/tenant-audit.module';
import { TenantOnboardingController } from './tenant-onboarding.controller';
import { TenantOnboardingRepository } from './tenant-onboarding.repository';
import { TenantOnboardingService } from './tenant-onboarding.service';

@Module({
  imports: [DatabaseModule, FoundationDbModule, AuthModule, TenantAuditModule],
  controllers: [TenantOnboardingController],
  providers: [TenantOnboardingRepository, TenantOnboardingService],
  exports: [TenantOnboardingService, TenantOnboardingRepository],
})
export class TenantOnboardingModule {}
