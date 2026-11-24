import { Injectable } from '@nestjs/common';
import type {
  IndustryCode,
  OrganizationType,
  TenantStatus,
} from '@ft360/shared-types';
import type { QueryExecutor } from '../../database/database.types';
import type { UpdateOrganizationProfileDto } from './organization-profile.dto';

export interface OrganizationProfileRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  legal_name: string;
  status: TenantStatus;
  organization_type: OrganizationType;
  industry: IndustryCode;
  company_size_band: string | null;
  registration_number: string | null;
  tax_id: string | null;
  website_url: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  primary_contact_phone_e164: string | null;
  support_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country_code: string;
  about_description: string | null;
  updated_by_membership_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class OrganizationProfileRepository {
  async getProfile(
    tx: QueryExecutor,
    tenantId: string,
  ): Promise<OrganizationProfileRow | null> {
    const res = await tx.query<OrganizationProfileRow>(
      `SELECT
         t.id AS tenant_id,
         t.slug,
         t.display_name,
         t.legal_name,
         t.status,
         tp.organization_type,
         tp.industry,
         tp.company_size_band,
         tp.registration_number,
         tp.tax_id,
         tp.website_url,
         tp.primary_contact_name,
         tp.primary_contact_email,
         tp.primary_contact_phone_e164,
         tp.support_email,
         tp.address_line1,
         tp.address_line2,
         tp.city,
         tp.state_province,
         tp.postal_code,
         tp.country_code,
         tp.about_description,
         tp.updated_by_membership_id,
         tp.version,
         tp.created_at,
         tp.updated_at
       FROM public.tenants t
       JOIN public.tenant_profiles tp ON tp.tenant_id = t.id
       WHERE t.id = $1::uuid`,
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  async updateProfile(
    tx: QueryExecutor,
    tenantId: string,
    expectedVersion: number,
    dto: UpdateOrganizationProfileDto,
    membershipId: string | null,
  ): Promise<OrganizationProfileRow | null> {
    const res = await tx.query<{ version: number }>(
      `UPDATE public.tenant_profiles
       SET
         organization_type = $3,
         industry = $4,
         company_size_band = $5,
         registration_number = $6,
         tax_id = $7,
         website_url = $8,
         primary_contact_name = $9,
         primary_contact_email = $10,
         primary_contact_phone_e164 = $11,
         support_email = $12,
         address_line1 = $13,
         address_line2 = $14,
         city = $15,
         state_province = $16,
         postal_code = $17,
         country_code = $18,
         about_description = $19,
         updated_by_membership_id = $20::uuid,
         version = version + 1,
         updated_at = NOW()
       WHERE tenant_id = $1::uuid AND version = $2
       RETURNING version`,
      [
        tenantId,
        expectedVersion,
        dto.organizationType,
        dto.industry,
        dto.companySizeBand ?? null,
        dto.registrationNumber ?? null,
        dto.taxId ?? null,
        dto.websiteUrl ?? null,
        dto.primaryContactName ?? null,
        dto.primaryContactEmail ?? null,
        dto.primaryContactPhoneE164 ?? null,
        dto.supportEmail ?? null,
        dto.addressLine1 ?? null,
        dto.addressLine2 ?? null,
        dto.city ?? null,
        dto.stateProvince ?? null,
        dto.postalCode ?? null,
        dto.countryCode,
        dto.aboutDescription ?? null,
        membershipId,
      ],
    );

    if (res.rowCount === 0) {
      return null;
    }

    await tx.query(
      `UPDATE public.tenants
       SET
         display_name = $2,
         legal_name = $3,
         updated_at = NOW()
       WHERE id = $1::uuid`,
      [tenantId, dto.displayName, dto.legalName],
    );

    return this.getProfile(tx, tenantId);
  }
}
