import { Injectable } from '@nestjs/common';
import type { MembershipStatus, TenantStatus, UserStatus } from '@ft360/shared-types';
import type {
  TenantMembershipRecord,
  TenantMembershipVerifier,
} from '../common/tenant-membership.guard';
import { isValidUuid } from '../common/uuid.util';
import { DatabasePoolService } from './database-pool.service';

interface VerifyMembershipRow {
  membership_id: string;
  tenant_id: string;
  user_id: string;
  membership_type: string;
  membership_status: MembershipStatus;
  tenant_status: TenantStatus;
  user_status: UserStatus;
}

/**
 * PostgreSQL-backed membership verifier executing the narrow SECURITY DEFINER
 * lookup `public.fn_verify_tenant_membership($1, $2)` via parameterized SQL.
 */
@Injectable()
export class PostgresTenantMembershipVerifier implements TenantMembershipVerifier {
  constructor(private readonly dbPool: DatabasePoolService) {}

  async findMembership(userId: string, tenantId: string): Promise<TenantMembershipRecord | null> {
    if (!isValidUuid(userId) || !isValidUuid(tenantId)) {
      return null;
    }

    const result = await this.dbPool.queryUnscoped<VerifyMembershipRow>(
      `SELECT
         membership_id,
         tenant_id,
         user_id,
         membership_type,
         membership_status,
         tenant_status,
         user_status
       FROM public.fn_verify_tenant_membership($1::uuid, $2::uuid)`,
      [userId.trim().toLowerCase(), tenantId.trim().toLowerCase()],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      membershipId: row.membership_id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      status: row.membership_status,
      tenantStatus: row.tenant_status,
      userStatus: row.user_status,
    };
  }
}
