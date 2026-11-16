import { Module } from '@nestjs/common';
import { TenantAdminGuard } from '../../common/tenant-admin.guard';
import { TenantPermissionGuard } from '../../common/tenant-permission.guard';
import { AuthModule } from '../auth/auth.module';
import { FoundationDbModule } from '../foundation-db/foundation-db.module';
import { TenantAuditController } from './tenant-audit.controller';
import { TenantAuditRepository } from './tenant-audit.repository';
import { TenantAuditService } from './tenant-audit.service';

@Module({
  imports: [FoundationDbModule, AuthModule],
  controllers: [TenantAuditController],
  providers: [
    TenantAuditRepository,
    TenantAuditService,
    TenantAdminGuard,
    TenantPermissionGuard,
  ],
  exports: [TenantAuditRepository, TenantAuditService, TenantPermissionGuard],
})
export class TenantAuditModule {}
