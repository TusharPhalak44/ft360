import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { FoundationDbModule } from '../foundation-db/foundation-db.module';
import { TenantAuditModule } from '../tenant-audit/tenant-audit.module';
import { OrganizationSettingsController } from './organization-settings.controller';
import { OrganizationSettingsRepository } from './organization-settings.repository';
import { OrganizationSettingsService } from './organization-settings.service';

@Module({
  imports: [DatabaseModule, FoundationDbModule, AuthModule, TenantAuditModule],
  controllers: [OrganizationSettingsController],
  providers: [OrganizationSettingsRepository, OrganizationSettingsService],
  exports: [OrganizationSettingsService, OrganizationSettingsRepository],
})
export class OrganizationSettingsModule {}
