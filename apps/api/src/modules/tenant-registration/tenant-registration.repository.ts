import { Injectable } from '@nestjs/common';
import type { QueryExecutor } from '../../database/database.types';

export interface ProvisionOrganizationParams {
  actorUserId: string;
  sessionId: string;
  slug: string;
  displayName: string;
  legalName: string;
  organizationType: string;
  industry: string;
  countryCode: string;
  defaultTimezone: string;
  defaultCurrency: string;
  correlationId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ProvisionOrganizationRow {
  tenant_id: string;
  tenant_slug: string;
  legal_name: string;
  display_name: string;
  tenant_status: string;
  default_timezone: string;
  default_currency: string;
  created_by_user_id: string;
  tenant_created_at: Date | string;
  tenant_updated_at: Date | string;
  membership_id: string;
  membership_type: string;
  membership_status: string;
  is_primary_owner: boolean;
  admin_role_id: string;
  member_role_id: string;
  onboarding_status: string;
  onboarding_current_step: string;
  onboarding_version: number;
  bound_session_id: string;
  tenant_audit_log_id: string;
  auth_audit_log_id: string;
  effective_permissions: string[];
}

@Injectable()
export class TenantRegistrationRepository {
  /**
   * Calls `public.fn_check_tenant_slug_available(p_slug)` using native parameterized SQL.
   * Returns binary availability without disclosing any tenant metadata or reason.
   */
  async checkSlugAvailable(tx: QueryExecutor, slug: string): Promise<boolean> {
    const result = await tx.query<{ available: boolean }>(
      'SELECT public.fn_check_tenant_slug_available($1::citext) AS available',
      [slug],
    );
    return Boolean(result.rows[0]?.available);
  }

  /**
   * Calls `public.fn_tenant_provision_organization(...)` atomically inside PostgreSQL.
   * Creates the tenant, roles, role assignments, primary owner membership,
   * 1:1 companion records, session binding, and dual-ledger audit logs.
   */
  async provisionOrganization(
    tx: QueryExecutor,
    params: ProvisionOrganizationParams,
  ): Promise<ProvisionOrganizationRow> {
    const result = await tx.query<ProvisionOrganizationRow>(
      `SELECT
         tenant_id,
         tenant_slug,
         legal_name,
         display_name,
         tenant_status,
         default_timezone,
         default_currency,
         created_by_user_id,
         tenant_created_at,
         tenant_updated_at,
         membership_id,
         membership_type,
         membership_status,
         is_primary_owner,
         admin_role_id,
         member_role_id,
         onboarding_status,
         onboarding_current_step,
         onboarding_version,
         bound_session_id,
         tenant_audit_log_id,
         auth_audit_log_id,
         effective_permissions
       FROM public.fn_tenant_provision_organization(
         $1::uuid,
         $2::uuid,
         $3::citext,
         $4::varchar,
         $5::varchar,
         $6::varchar,
         $7::varchar,
         $8::char(2),
         $9::varchar,
         $10::char(3),
         $11::uuid,
         $12::inet,
         $13::varchar
       )`,
      [
        params.actorUserId,
        params.sessionId,
        params.slug,
        params.displayName,
        params.legalName,
        params.organizationType,
        params.industry,
        params.countryCode,
        params.defaultTimezone,
        params.defaultCurrency,
        params.correlationId,
        params.ipAddress,
        params.userAgent,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('fn_tenant_provision_organization returned an empty result set.');
    }
    return row;
  }
}
