import { Injectable } from '@nestjs/common';
import type {
  ActiveUserTenantSummary,
  MembershipStatus,
  MembershipType,
  TenantMembershipEntity,
  TenantStatus,
} from '@ft360/shared-types';
import { isValidUuid } from '../../common/uuid.util';
import { DatabasePoolService } from '../../database/database-pool.service';
import type { QueryExecutor } from '../../database/database.types';

export interface CreateMembershipInput {
  tenantId: string;
  userId: string;
  membershipType?: MembershipType;
  status?: MembershipStatus;
  jobTitle?: string | null;
  employeeCode?: string | null;
  invitedByUserId?: string | null;
}

interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  membership_type: MembershipType;
  status: MembershipStatus;
  job_title: string | null;
  employee_code: string | null;
  invited_by_user_id: string | null;
  joined_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ActiveTenantRow {
  membership_id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_display_name: string;
  tenant_status: TenantStatus;
  membership_type: MembershipType;
  membership_status: MembershipStatus;
}

function toIso(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : String(val);
}

@Injectable()
export class TenantMembershipRepository {
  constructor(private readonly dbPool: DatabasePoolService) {}

  async createMembership(
    tx: QueryExecutor,
    input: CreateMembershipInput,
  ): Promise<TenantMembershipEntity> {
    const status = input.status ?? 'INVITED';
    const joinedAt = status === 'ACTIVE' ? new Date().toISOString() : null;
    const res = await tx.query<MembershipRow>(
      `INSERT INTO public.tenant_memberships (
         tenant_id,
         user_id,
         membership_type,
         status,
         job_title,
         employee_code,
         invited_by_user_id,
         joined_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING
         id, tenant_id, user_id, membership_type, status,
         job_title, employee_code, invited_by_user_id, joined_at, created_at, updated_at`,
      [
        input.tenantId,
        input.userId,
        input.membershipType ?? 'INTERNAL',
        status,
        input.jobTitle ?? null,
        input.employeeCode ?? null,
        input.invitedByUserId ?? null,
        joinedAt,
      ],
    );
    return this.mapMembership(res.rows[0]);
  }

  async findMembershipById(
    tx: QueryExecutor,
    tenantId: string,
    membershipId: string,
  ): Promise<TenantMembershipEntity | null> {
    const res = await tx.query<MembershipRow>(
      `SELECT
         id, tenant_id, user_id, membership_type, status,
         job_title, employee_code, invited_by_user_id, joined_at, created_at, updated_at
       FROM public.tenant_memberships
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, membershipId],
    );
    return res.rows[0] ? this.mapMembership(res.rows[0]) : null;
  }

  async listMemberships(tx: QueryExecutor, tenantId: string): Promise<TenantMembershipEntity[]> {
    const res = await tx.query<MembershipRow>(
      `SELECT
         id, tenant_id, user_id, membership_type, status,
         job_title, employee_code, invited_by_user_id, joined_at, created_at, updated_at
       FROM public.tenant_memberships
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId],
    );
    return res.rows.map((r) => this.mapMembership(r));
  }

  async updateMembershipStatus(
    tx: QueryExecutor,
    tenantId: string,
    membershipId: string,
    status: MembershipStatus,
  ): Promise<TenantMembershipEntity | null> {
    const res = await tx.query<MembershipRow>(
      `UPDATE public.tenant_memberships
       SET
         status = $3::varchar(24),
         joined_at = CASE WHEN $3::varchar(24) = 'ACTIVE' AND joined_at IS NULL THEN NOW() ELSE joined_at END
       WHERE tenant_id = $1 AND id = $2
       RETURNING
         id, tenant_id, user_id, membership_type, status,
         job_title, employee_code, invited_by_user_id, joined_at, created_at, updated_at`,
      [tenantId, membershipId, status],
    );
    return res.rows[0] ? this.mapMembership(res.rows[0]) : null;
  }

  async listUserActiveTenants(userId: string): Promise<ActiveUserTenantSummary[]> {
    if (!isValidUuid(userId)) {
      return [];
    }
    const res = await this.dbPool.queryUnscoped<ActiveTenantRow>(
      `SELECT
         membership_id,
         tenant_id,
         tenant_slug::text AS tenant_slug,
         tenant_display_name,
         tenant_status,
         membership_type,
         membership_status
       FROM public.fn_list_user_tenants($1::uuid)`,
      [userId.trim().toLowerCase()],
    );
    return res.rows.map((row) => ({
      membershipId: row.membership_id,
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      tenantDisplayName: row.tenant_display_name,
      tenantStatus: row.tenant_status,
      membershipType: row.membership_type,
      membershipStatus: row.membership_status,
    }));
  }

  private mapMembership(row: MembershipRow): TenantMembershipEntity {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      membershipType: row.membership_type,
      status: row.status,
      jobTitle: row.job_title,
      employeeCode: row.employee_code,
      invitedByUserId: row.invited_by_user_id,
      joinedAt: row.joined_at ? toIso(row.joined_at) : null,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}
