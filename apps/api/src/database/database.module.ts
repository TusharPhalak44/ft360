import { Global, Module } from '@nestjs/common';
import { TENANT_MEMBERSHIP_VERIFIER } from '../common/tenant-membership.guard';
import { DatabasePoolService } from './database-pool.service';
import { PostgresTenantMembershipVerifier } from './postgres-tenant-membership.verifier';
import { TenantTransactionManager } from './tenant-transaction.manager';

@Global()
@Module({
  providers: [
    DatabasePoolService,
    TenantTransactionManager,
    PostgresTenantMembershipVerifier,
    {
      provide: TENANT_MEMBERSHIP_VERIFIER,
      useExisting: PostgresTenantMembershipVerifier,
    },
  ],
  exports: [
    DatabasePoolService,
    TenantTransactionManager,
    PostgresTenantMembershipVerifier,
    TENANT_MEMBERSHIP_VERIFIER,
  ],
})
export class DatabaseModule {}
