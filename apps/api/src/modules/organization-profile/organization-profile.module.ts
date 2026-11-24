import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { FoundationDbModule } from '../foundation-db/foundation-db.module';
import { TenantAuditModule } from '../tenant-audit/tenant-audit.module';
import { OrganizationProfileController } from './organization-profile.controller';
import { OrganizationProfileRepository } from './organization-profile.repository';
import { OrganizationProfileService } from './organization-profile.service';

@Module({
  imports: [DatabaseModule, FoundationDbModule, AuthModule, TenantAuditModule],
  controllers: [OrganizationProfileController],
  providers: [OrganizationProfileRepository, OrganizationProfileService],
  exports: [OrganizationProfileService, OrganizationProfileRepository],
})
export class OrganizationProfileModule {}
