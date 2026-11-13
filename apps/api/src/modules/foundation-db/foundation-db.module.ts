import { Module } from '@nestjs/common';
import { PlatformDirectoryRepository } from './platform-directory.repository';
import { RbacRepository } from './rbac.repository';
import { TenantMembershipRepository } from './tenant-membership.repository';

@Module({
  providers: [PlatformDirectoryRepository, TenantMembershipRepository, RbacRepository],
  exports: [PlatformDirectoryRepository, TenantMembershipRepository, RbacRepository],
})
export class FoundationDbModule {}
