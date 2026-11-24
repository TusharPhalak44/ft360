import { Injectable } from '@nestjs/common';
import type { QueryExecutor } from '../../database/database.types';
import type { UpdateOrganizationSettingsDto } from './organization-settings.dto';

export interface TenantSettingsRow {
  tenant_id: string;
  timezone: string;
  locale: string;
  date_format: string;
  time_format: string;
  default_currency: string;
  week_start_day: number;
  fiscal_year_start_month: number;
  invitation_expiry_hours: number;
  allow_member_directory_view: boolean;
  updated_by_membership_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class OrganizationSettingsRepository {
  async getSettings(
    tx: QueryExecutor,
    tenantId: string,
  ): Promise<TenantSettingsRow | null> {
    const res = await tx.query<TenantSettingsRow>(
      `SELECT
         tenant_id,
         timezone,
         locale,
         date_format,
         time_format,
         default_currency,
         week_start_day,
         fiscal_year_start_month,
         invitation_expiry_hours,
         allow_member_directory_view,
         updated_by_membership_id,
         version,
         created_at,
         updated_at
       FROM public.tenant_settings
       WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  async updateSettings(
    tx: QueryExecutor,
    tenantId: string,
    expectedVersion: number,
    dto: UpdateOrganizationSettingsDto,
    membershipId: string | null,
  ): Promise<TenantSettingsRow | null> {
    const res = await tx.query<TenantSettingsRow>(
      `UPDATE public.tenant_settings
       SET
         timezone = $3,
         locale = $4,
         date_format = $5,
         time_format = $6,
         default_currency = $7,
         week_start_day = $8,
         fiscal_year_start_month = $9,
         invitation_expiry_hours = $10,
         allow_member_directory_view = $11,
         updated_by_membership_id = $12::uuid,
         version = version + 1,
         updated_at = NOW()
       WHERE tenant_id = $1::uuid AND version = $2
       RETURNING
         tenant_id,
         timezone,
         locale,
         date_format,
         time_format,
         default_currency,
         week_start_day,
         fiscal_year_start_month,
         invitation_expiry_hours,
         allow_member_directory_view,
         updated_by_membership_id,
         version,
         created_at,
         updated_at`,
      [
        tenantId,
        expectedVersion,
        dto.timezone,
        dto.locale,
        dto.dateFormat,
        dto.timeFormat,
        dto.defaultCurrency,
        dto.weekStartDay,
        dto.fiscalYearStartMonth,
        dto.invitationExpiryHours,
        dto.allowMemberDirectoryView,
        membershipId,
      ],
    );

    if (res.rowCount === 0 || !res.rows[0]) {
      return null;
    }

    // Synchronize default timezone and default currency on public.tenants
    await tx.query(
      `UPDATE public.tenants
       SET
         default_timezone = $2,
         default_currency = $3,
         updated_at = NOW()
       WHERE id = $1::uuid`,
      [tenantId, dto.timezone, dto.defaultCurrency],
    );

    return res.rows[0];
  }
}
