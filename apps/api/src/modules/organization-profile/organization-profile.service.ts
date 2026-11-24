import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  OrganizationProfilePayload,
  VerifiedTenantContext,
} from '@ft360/shared-types';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { TenantAuditService } from '../tenant-audit/tenant-audit.service';
import type { UpdateOrganizationProfileDto } from './organization-profile.dto';
import {
  OrganizationProfileRepository,
  type OrganizationProfileRow,
} from './organization-profile.repository';

@Injectable()
export class OrganizationProfileService {
  constructor(
    private readonly repo: OrganizationProfileRepository,
    private readonly txManager: TenantTransactionManager,
    private readonly auditService: TenantAuditService,
  ) {}

  async getProfile(ctx: VerifiedTenantContext): Promise<OrganizationProfilePayload> {
    return this.txManager.withVerifiedMemberTransaction(ctx, async (tx) => {
      const row = await this.repo.getProfile(tx, ctx.tenantId);
      if (!row) {
        throw new NotFoundException({
          code: 'TENANT_PROFILE_NOT_FOUND',
          message: 'Organization profile not found for the active organization.',
        });
      }
      return this.mapRowToPayload(row);
    });
  }

  async updateProfile(
    ctx: VerifiedTenantContext,
    dto: UpdateOrganizationProfileDto,
  ): Promise<OrganizationProfilePayload> {
    return this.txManager.withVerifiedMemberTransaction(ctx, async (tx, verifiedMembershipId) => {
      const current = await this.repo.getProfile(tx, ctx.tenantId);
      if (!current) {
        throw new NotFoundException({
          code: 'TENANT_PROFILE_NOT_FOUND',
          message: 'Organization profile not found for the active organization.',
        });
      }

      if (current.version !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'PROFILE_VERSION_CONFLICT',
          message:
            'Profile has been updated by another process. Please reload and retry.',
        });
      }

      const updated = await this.repo.updateProfile(
        tx,
        ctx.tenantId,
        dto.expectedVersion,
        dto,
        verifiedMembershipId,
      );

      if (!updated) {
        throw new ConflictException({
          code: 'PROFILE_VERSION_CONFLICT',
          message:
            'Profile has been updated by another process. Please reload and retry.',
        });
      }

      const beforeState: Record<string, unknown> = {
        displayName: current.display_name,
        legalName: current.legal_name,
        organizationType: current.organization_type,
        industry: current.industry,
        companySizeBand: current.company_size_band,
        registrationNumber: current.registration_number,
        taxId: current.tax_id,
        websiteUrl: current.website_url,
        primaryContactName: current.primary_contact_name,
        primaryContactEmail: current.primary_contact_email,
        primaryContactPhoneE164: current.primary_contact_phone_e164,
        supportEmail: current.support_email,
        addressLine1: current.address_line1,
        addressLine2: current.address_line2,
        city: current.city,
        stateProvince: current.state_province,
        postalCode: current.postal_code,
        countryCode: current.country_code,
        aboutDescription: current.about_description,
      };

      const afterState: Record<string, unknown> = {
        displayName: updated.display_name,
        legalName: updated.legal_name,
        organizationType: updated.organization_type,
        industry: updated.industry,
        companySizeBand: updated.company_size_band,
        registrationNumber: updated.registration_number,
        taxId: updated.tax_id,
        websiteUrl: updated.website_url,
        primaryContactName: updated.primary_contact_name,
        primaryContactEmail: updated.primary_contact_email,
        primaryContactPhoneE164: updated.primary_contact_phone_e164,
        supportEmail: updated.support_email,
        addressLine1: updated.address_line1,
        addressLine2: updated.address_line2,
        city: updated.city,
        stateProvince: updated.state_province,
        postalCode: updated.postal_code,
        countryCode: updated.country_code,
        aboutDescription: updated.about_description,
      };

      const diff = this.auditService.computeFieldDiff(beforeState, afterState);

      await this.auditService.recordTenantEvent(tx, ctx, {
        eventType: 'TENANT_PROFILE_UPDATED',
        resourceType: 'PROFILE',
        resourceId: ctx.tenantId,
        beforeState: diff.beforeState,
        afterState: diff.afterState,
        metadata: {
          changedFields: diff.changedFields,
          version: updated.version,
        },
      });

      return this.mapRowToPayload(updated);
    });
  }

  private mapRowToPayload(row: OrganizationProfileRow): OrganizationProfilePayload {
    return {
      tenantId: row.tenant_id,
      slug: row.slug,
      displayName: row.display_name,
      legalName: row.legal_name,
      status: row.status,
      organizationType: row.organization_type,
      industry: row.industry,
      companySizeBand: row.company_size_band,
      registrationNumber: row.registration_number,
      taxId: row.tax_id,
      websiteUrl: row.website_url,
      primaryContactName: row.primary_contact_name,
      primaryContactEmail: row.primary_contact_email,
      primaryContactPhoneE164: row.primary_contact_phone_e164,
      supportEmail: row.support_email,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      stateProvince: row.state_province,
      postalCode: row.postal_code,
      countryCode: row.country_code,
      aboutDescription: row.about_description,
      version: row.version,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    };
  }
}
