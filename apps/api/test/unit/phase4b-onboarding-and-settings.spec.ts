import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { VerifiedTenantContext } from '@ft360/shared-types';
import type { RedisService } from '../../src/cache/redis.service';
import type { RequestWithVerifiedTenant } from '../../src/common/tenant-membership.guard';
import type { QueryExecutor } from '../../src/database/database.types';
import type { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { OrganizationProfileController } from '../../src/modules/organization-profile/organization-profile.controller';
import { UpdateOrganizationProfileDto } from '../../src/modules/organization-profile/organization-profile.dto';
import type {
  OrganizationProfileRepository,
  OrganizationProfileRow,
} from '../../src/modules/organization-profile/organization-profile.repository';
import { OrganizationProfileService } from '../../src/modules/organization-profile/organization-profile.service';
import { OrganizationSettingsController } from '../../src/modules/organization-settings/organization-settings.controller';
import { UpdateOrganizationSettingsDto } from '../../src/modules/organization-settings/organization-settings.dto';
import type {
  OrganizationSettingsRepository,
  TenantSettingsRow,
} from '../../src/modules/organization-settings/organization-settings.repository';
import { OrganizationSettingsService } from '../../src/modules/organization-settings/organization-settings.service';
import type { TenantAuditService } from '../../src/modules/tenant-audit/tenant-audit.service';
import { TenantOnboardingController } from '../../src/modules/tenant-onboarding/tenant-onboarding.controller';
import {
  CompleteOnboardingDto,
  OnboardingStepParamDto,
  UpdateOnboardingStepDto,
} from '../../src/modules/tenant-onboarding/tenant-onboarding.dto';
import type {
  TenantOnboardingRepository,
  TenantOnboardingStateRow,
} from '../../src/modules/tenant-onboarding/tenant-onboarding.repository';
import { TenantOnboardingService } from '../../src/modules/tenant-onboarding/tenant-onboarding.service';

const TENANT_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91404';
const USER_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91101';
const MEMBERSHIP_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91505';
const CORRELATION_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b91606';

const mockContext: VerifiedTenantContext = {
  tenantId: TENANT_ID,
  actorUserId: USER_ID,
  membershipId: MEMBERSHIP_ID,
  correlationId: CORRELATION_ID,
};

describe('Phase 4 Stage 4B-API-02 Unit Suite — Onboarding, Profile & Settings', () => {
  // =========================================================================
  // 1. DTO Validation
  // =========================================================================
  describe('1. DTO Validation & Transformations', () => {
    describe('OnboardingStepParamDto', () => {
      it('accepts valid onboarding step route parameters', async () => {
        const validSteps = ['org-profile', 'org-settings', 'org-branding', 'team-invites'];
        for (const step of validSteps) {
          const dto = plainToInstance(OnboardingStepParamDto, { step });
          const errors = await validate(dto);
          expect(errors).toHaveLength(0);
        }
      });

      it('rejects invalid or unknown step identifiers', async () => {
        const invalidSteps = ['review-complete', 'invalid-step', 'ORG_PROFILE', ''];
        for (const step of invalidSteps) {
          const dto = plainToInstance(OnboardingStepParamDto, { step });
          const errors = await validate(dto);
          expect(errors.length).toBeGreaterThan(0);
        }
      });
    });

    describe('UpdateOnboardingStepDto', () => {
      it('validates minimum expectedVersion and allows optional skipped flag', async () => {
        const dto = plainToInstance(UpdateOnboardingStepDto, {
          expectedVersion: 1,
          skipped: true,
        });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      });

      it('rejects missing or zero expectedVersion', async () => {
        const dto = plainToInstance(UpdateOnboardingStepDto, {
          expectedVersion: 0,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });
    });

    describe('CompleteOnboardingDto', () => {
      it('validates expectedVersion >= 1', async () => {
        const validDto = plainToInstance(CompleteOnboardingDto, { expectedVersion: 2 });
        expect(await validate(validDto)).toHaveLength(0);

        const invalidDto = plainToInstance(CompleteOnboardingDto, { expectedVersion: -1 });
        expect((await validate(invalidDto)).length).toBeGreaterThan(0);
      });
    });

    describe('UpdateOrganizationProfileDto', () => {
      it('accepts a fully compliant profile update payload', async () => {
        const dto = plainToInstance(UpdateOrganizationProfileDto, {
          displayName: 'Acme Corp',
          legalName: 'Acme International LLC',
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'US',
          companySizeBand: '11-50',
          registrationNumber: 'REG-987654',
          taxId: 'TAX-123456',
          websiteUrl: 'https://acme.example.com',
          primaryContactName: 'Jane Doe',
          primaryContactEmail: 'jane@acme.example.com',
          primaryContactPhoneE164: '+14155552671',
          supportEmail: 'support@acme.example.com',
          addressLine1: '100 Market St',
          addressLine2: 'Suite 400',
          city: 'San Francisco',
          stateProvince: 'CA',
          postalCode: '94105',
          aboutDescription: 'Leading SaaS data analytics platform.',
          expectedVersion: 1,
        });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      });

      it('rejects invalid email, countryCode, phone number format, and URL', async () => {
        const dto = plainToInstance(UpdateOrganizationProfileDto, {
          displayName: 'Acme Corp',
          legalName: 'Acme International LLC',
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'USA', // Invalid: must be 2-letter alpha-2
          websiteUrl: 'not-a-valid-url',
          primaryContactEmail: 'not-an-email',
          primaryContactPhoneE164: '12345', // Invalid: must be E.164 (+...)
          expectedVersion: 1,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });
    });

    describe('UpdateOrganizationSettingsDto', () => {
      it('accepts valid regional and governance settings', async () => {
        const dto = plainToInstance(UpdateOrganizationSettingsDto, {
          timezone: 'America/New_York',
          locale: 'en-US',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '24H',
          defaultCurrency: 'USD',
          weekStartDay: 1,
          fiscalYearStartMonth: 1,
          invitationExpiryHours: 168,
          allowMemberDirectoryView: false,
          expectedVersion: 1,
        });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      });

      it('normalizes lowercase currency code to uppercase', async () => {
        const dto = plainToInstance(UpdateOrganizationSettingsDto, {
          timezone: 'UTC',
          locale: 'en-GB',
          dateFormat: 'DD/MM/YYYY',
          timeFormat: '12H',
          defaultCurrency: 'eur',
          weekStartDay: 0,
          fiscalYearStartMonth: 4,
          invitationExpiryHours: 72,
          allowMemberDirectoryView: true,
          expectedVersion: 2,
        });
        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
        expect(dto.defaultCurrency).toBe('EUR');
      });

      it('rejects invalid timezone, invalid locale, and out-of-range bounds', async () => {
        const dto = plainToInstance(UpdateOrganizationSettingsDto, {
          timezone: 'Invalid/TimeZone_Zone',
          locale: 'invalid--locale',
          dateFormat: 'INVALID_FORMAT',
          timeFormat: '48H',
          defaultCurrency: 'TOOLONG',
          weekStartDay: 7, // out of range (0..6)
          fiscalYearStartMonth: 13, // out of range (1..12)
          invitationExpiryHours: 1000, // out of range (1..720)
          allowMemberDirectoryView: false,
          expectedVersion: 1,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });
    });
  });

  // =========================================================================
  // 2. Tenant Onboarding Service
  // =========================================================================
  describe('2. Tenant Onboarding Service', () => {
    let service: TenantOnboardingService;
    let repo: jest.Mocked<TenantOnboardingRepository>;
    let txManager: TenantTransactionManager;
    let auditService: jest.Mocked<TenantAuditService>;

    const mockRow: TenantOnboardingStateRow = {
      tenant_id: TENANT_ID,
      onboarding_status: 'IN_PROGRESS',
      current_step: 'ORG_PROFILE',
      org_profile_completed_at: null,
      org_settings_completed_at: null,
      org_branding_completed_at: null,
      org_branding_skipped: false,
      team_invites_completed_at: null,
      team_invites_skipped: false,
      completed_at: null,
      completed_by_membership_id: null,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };

    beforeEach(() => {
      repo = {
        getOnboardingState: jest.fn(),
        updateStep: jest.fn(),
        completeOnboarding: jest.fn(),
      } as unknown as jest.Mocked<TenantOnboardingRepository>;

      txManager = {
        withVerifiedMemberTransaction: jest
          .fn()
          .mockImplementation((_ctx, cb) => cb({} as QueryExecutor, MEMBERSHIP_ID)),
      } as unknown as TenantTransactionManager;

      auditService = {
        recordTenantEvent: jest.fn().mockResolvedValue('audit-id-1'),
      } as unknown as jest.Mocked<TenantAuditService>;

      service = new TenantOnboardingService(repo, txManager, auditService);
    });

    it('retrieves onboarding state and maps to payload format', async () => {
      repo.getOnboardingState.mockResolvedValueOnce(mockRow);
      const res = await service.getOnboardingState(mockContext);

      expect(res.tenantId).toBe(TENANT_ID);
      expect(res.onboardingStatus).toBe('IN_PROGRESS');
      expect(res.currentStep).toBe('ORG_PROFILE');
      expect(res.steps.orgProfile.completed).toBe(false);
      expect(res.version).toBe(1);
    });

    it('throws NotFoundException if onboarding state row is missing', async () => {
      repo.getOnboardingState.mockResolvedValueOnce(null);
      await expect(service.getOnboardingState(mockContext)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects skipping mandatory step org-profile with 422 UnprocessableEntityException', async () => {
      await expect(
        service.updateStep(mockContext, 'org-profile', {
          expectedVersion: 1,
          skipped: true,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('rejects skipping mandatory step org-settings with 422 UnprocessableEntityException', async () => {
      await expect(
        service.updateStep(mockContext, 'org-settings', {
          expectedVersion: 1,
          skipped: true,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws ConflictException on version mismatch during updateStep', async () => {
      repo.getOnboardingState.mockResolvedValueOnce({
        ...mockRow,
        version: 2,
      });

      await expect(
        service.updateStep(mockContext, 'org-profile', {
          expectedVersion: 1,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('advances org-profile step and records audit log', async () => {
      repo.getOnboardingState.mockResolvedValueOnce(mockRow);
      repo.updateStep.mockResolvedValueOnce({
        ...mockRow,
        current_step: 'ORG_SETTINGS',
        org_profile_completed_at: new Date(),
        version: 2,
      });

      const res = await service.updateStep(mockContext, 'org-profile', {
        expectedVersion: 1,
      });

      expect(res.currentStep).toBe('ORG_SETTINGS');
      expect(res.steps.orgProfile.completed).toBe(true);
      expect(res.version).toBe(2);
      expect(auditService.recordTenantEvent).toHaveBeenCalledWith(
        expect.anything(),
        mockContext,
        expect.objectContaining({
          eventType: 'TENANT_ONBOARDING_STEP_SAVED',
          resourceType: 'ONBOARDING',
          resourceId: TENANT_ID,
        }),
      );
    });

    it('allows skipping optional step org-branding', async () => {
      repo.getOnboardingState.mockResolvedValueOnce({
        ...mockRow,
        current_step: 'ORG_BRANDING',
        version: 2,
      });
      repo.updateStep.mockResolvedValueOnce({
        ...mockRow,
        current_step: 'TEAM_INVITES',
        org_branding_skipped: true,
        version: 3,
      });

      const res = await service.updateStep(mockContext, 'org-branding', {
        expectedVersion: 2,
        skipped: true,
      });

      expect(res.currentStep).toBe('TEAM_INVITES');
      expect(res.steps.orgBranding.skipped).toBe(true);
      expect(res.version).toBe(3);
    });

    it('rejects completeOnboarding when mandatory prerequisites are incomplete', async () => {
      repo.getOnboardingState.mockResolvedValueOnce({
        ...mockRow,
        org_profile_completed_at: new Date(),
        org_settings_completed_at: null, // Still incomplete
      });

      await expect(
        service.completeOnboarding(mockContext, { expectedVersion: 1 }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('successfully finalizes onboarding when prerequisites are satisfied', async () => {
      const completedAt = new Date();
      repo.getOnboardingState.mockResolvedValueOnce({
        ...mockRow,
        org_profile_completed_at: new Date(),
        org_settings_completed_at: new Date(),
        version: 2,
      });
      repo.completeOnboarding.mockResolvedValueOnce({
        ...mockRow,
        onboarding_status: 'COMPLETED',
        completed_at: completedAt,
        completed_by_membership_id: MEMBERSHIP_ID,
        version: 3,
      });

      const res = await service.completeOnboarding(mockContext, { expectedVersion: 2 });
      expect(res.onboardingStatus).toBe('COMPLETED');
      expect(res.version).toBe(3);
      expect(auditService.recordTenantEvent).toHaveBeenCalledWith(
        expect.anything(),
        mockContext,
        expect.objectContaining({
          eventType: 'TENANT_ONBOARDING_COMPLETED',
          resourceType: 'ONBOARDING',
        }),
      );
    });
  });

  // =========================================================================
  // 3. Organization Profile Service
  // =========================================================================
  describe('3. Organization Profile Service', () => {
    let service: OrganizationProfileService;
    let repo: jest.Mocked<OrganizationProfileRepository>;
    let txManager: TenantTransactionManager;
    let auditService: jest.Mocked<TenantAuditService>;

    const mockProfileRow: OrganizationProfileRow = {
      tenant_id: TENANT_ID,
      slug: 'acme-corp',
      display_name: 'Acme Corporation',
      legal_name: 'Acme Corporation LLC',
      status: 'ACTIVE',
      organization_type: 'COMPANY',
      industry: 'SAAS_TECHNOLOGY',
      company_size_band: '11-50',
      registration_number: 'REG-1234',
      tax_id: 'TAX-5678',
      website_url: 'https://acme.example.com',
      primary_contact_name: 'Jane Doe',
      primary_contact_email: 'jane@acme.example.com',
      primary_contact_phone_e164: '+14155552671',
      support_email: 'support@acme.example.com',
      address_line1: '100 Market St',
      address_line2: null,
      city: 'San Francisco',
      state_province: 'CA',
      postal_code: '94105',
      country_code: 'US',
      about_description: 'About Acme',
      updated_by_membership_id: MEMBERSHIP_ID,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };

    beforeEach(() => {
      repo = {
        getProfile: jest.fn(),
        updateProfile: jest.fn(),
      } as unknown as jest.Mocked<OrganizationProfileRepository>;

      txManager = {
        withVerifiedMemberTransaction: jest
          .fn()
          .mockImplementation((_ctx, cb) => cb({} as QueryExecutor, MEMBERSHIP_ID)),
      } as unknown as TenantTransactionManager;

      auditService = {
        computeFieldDiff: jest.fn().mockReturnValue({
          beforeState: { displayName: 'Acme Corporation' },
          afterState: { displayName: 'Acme Corporation Inc' },
          changedFields: ['displayName'],
        }),
        recordTenantEvent: jest.fn().mockResolvedValue('audit-profile-1'),
      } as unknown as jest.Mocked<TenantAuditService>;

      service = new OrganizationProfileService(repo, txManager, auditService);
    });

    it('retrieves joined organization profile payload', async () => {
      repo.getProfile.mockResolvedValueOnce(mockProfileRow);
      const res = await service.getProfile(mockContext);

      expect(res.tenantId).toBe(TENANT_ID);
      expect(res.slug).toBe('acme-corp');
      expect(res.displayName).toBe('Acme Corporation');
      expect(res.legalName).toBe('Acme Corporation LLC');
      expect(res.countryCode).toBe('US');
      expect(res.version).toBe(1);
    });

    it('throws NotFoundException if profile does not exist', async () => {
      repo.getProfile.mockResolvedValueOnce(null);
      await expect(service.getProfile(mockContext)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException on version mismatch during update', async () => {
      repo.getProfile.mockResolvedValueOnce({
        ...mockProfileRow,
        version: 2,
      });

      await expect(
        service.updateProfile(mockContext, {
          displayName: 'Acme Corp Updated',
          legalName: 'Acme Corp Legal Updated',
          organizationType: 'COMPANY',
          industry: 'SAAS_TECHNOLOGY',
          countryCode: 'US',
          expectedVersion: 1,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('updates profile and companion tenant fields and records audit diff', async () => {
      repo.getProfile.mockResolvedValueOnce(mockProfileRow);
      repo.updateProfile.mockResolvedValueOnce({
        ...mockProfileRow,
        display_name: 'Acme Corporation Inc',
        version: 2,
      });

      const res = await service.updateProfile(mockContext, {
        displayName: 'Acme Corporation Inc',
        legalName: 'Acme Corporation LLC',
        organizationType: 'COMPANY',
        industry: 'SAAS_TECHNOLOGY',
        countryCode: 'US',
        expectedVersion: 1,
      });

      expect(res.displayName).toBe('Acme Corporation Inc');
      expect(res.version).toBe(2);
      expect(auditService.computeFieldDiff).toHaveBeenCalled();
      expect(auditService.recordTenantEvent).toHaveBeenCalledWith(
        expect.anything(),
        mockContext,
        expect.objectContaining({
          eventType: 'TENANT_PROFILE_UPDATED',
          resourceType: 'PROFILE',
        }),
      );
    });
  });

  // =========================================================================
  // 4. Organization Settings Service
  // =========================================================================
  describe('4. Organization Settings Service', () => {
    let service: OrganizationSettingsService;
    let repo: jest.Mocked<OrganizationSettingsRepository>;
    let txManager: TenantTransactionManager;
    let auditService: jest.Mocked<TenantAuditService>;
    let redis: jest.Mocked<RedisService>;

    const mockSettingsRow: TenantSettingsRow = {
      tenant_id: TENANT_ID,
      timezone: 'UTC',
      locale: 'en-US',
      date_format: 'YYYY-MM-DD',
      time_format: '24H',
      default_currency: 'USD',
      week_start_day: 1,
      fiscal_year_start_month: 1,
      invitation_expiry_hours: 168,
      allow_member_directory_view: false,
      updated_by_membership_id: MEMBERSHIP_ID,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };

    beforeEach(() => {
      repo = {
        getSettings: jest.fn(),
        updateSettings: jest.fn(),
      } as unknown as jest.Mocked<OrganizationSettingsRepository>;

      txManager = {
        withVerifiedMemberTransaction: jest
          .fn()
          .mockImplementation((_ctx, cb) => cb({} as QueryExecutor, MEMBERSHIP_ID)),
      } as unknown as TenantTransactionManager;

      auditService = {
        computeFieldDiff: jest.fn().mockReturnValue({
          beforeState: { timezone: 'UTC' },
          afterState: { timezone: 'America/New_York' },
          changedFields: ['timezone'],
        }),
        recordTenantEvent: jest.fn().mockResolvedValue('audit-settings-1'),
      } as unknown as jest.Mocked<TenantAuditService>;

      redis = {
        getTenantJson: jest.fn(),
        setTenantJson: jest.fn(),
        deleteTenantKey: jest.fn(),
      } as unknown as jest.Mocked<RedisService>;

      service = new OrganizationSettingsService(repo, txManager, auditService, redis);
    });

    it('returns settings from Redis cache on cache hit without querying database', async () => {
      const cachedPayload = {
        tenantId: TENANT_ID,
        timezone: 'America/New_York',
        locale: 'en-US',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '24H',
        defaultCurrency: 'USD',
        weekStartDay: 1,
        fiscalYearStartMonth: 1,
        invitationExpiryHours: 168,
        allowMemberDirectoryView: false,
        updatedByMembershipId: MEMBERSHIP_ID,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      redis.getTenantJson.mockResolvedValueOnce(cachedPayload);

      const res = await service.getSettings(mockContext);
      expect(res).toEqual(cachedPayload);
      expect(repo.getSettings).not.toHaveBeenCalled();
    });

    it('queries database on Redis cache miss and sets Redis cache', async () => {
      redis.getTenantJson.mockResolvedValueOnce(null);
      repo.getSettings.mockResolvedValueOnce(mockSettingsRow);

      const res = await service.getSettings(mockContext);
      expect(res.timezone).toBe('UTC');
      expect(res.version).toBe(1);
      expect(redis.setTenantJson).toHaveBeenCalledWith(
        TENANT_ID,
        'settings',
        'active',
        expect.objectContaining({ tenantId: TENANT_ID }),
        300,
      );
    });

    it('falls back seamlessly to database when Redis get throws an error', async () => {
      redis.getTenantJson.mockRejectedValueOnce(new Error('Redis connection refused'));
      repo.getSettings.mockResolvedValueOnce(mockSettingsRow);

      const res = await service.getSettings(mockContext);
      expect(res.tenantId).toBe(TENANT_ID);
      expect(res.timezone).toBe('UTC');
    });

    it('throws ConflictException on version mismatch during updateSettings', async () => {
      repo.getSettings.mockResolvedValueOnce({
        ...mockSettingsRow,
        version: 2,
      });

      await expect(
        service.updateSettings(mockContext, {
          timezone: 'America/New_York',
          locale: 'en-US',
          dateFormat: 'YYYY-MM-DD',
          timeFormat: '24H',
          defaultCurrency: 'USD',
          weekStartDay: 1,
          fiscalYearStartMonth: 1,
          invitationExpiryHours: 168,
          allowMemberDirectoryView: false,
          expectedVersion: 1,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('updates settings, invalidates Redis cache key, and records audit diff', async () => {
      repo.getSettings.mockResolvedValueOnce(mockSettingsRow);
      repo.updateSettings.mockResolvedValueOnce({
        ...mockSettingsRow,
        timezone: 'America/New_York',
        version: 2,
      });

      const res = await service.updateSettings(mockContext, {
        timezone: 'America/New_York',
        locale: 'en-US',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '24H',
        defaultCurrency: 'USD',
        weekStartDay: 1,
        fiscalYearStartMonth: 1,
        invitationExpiryHours: 168,
        allowMemberDirectoryView: false,
        expectedVersion: 1,
      });

      expect(res.timezone).toBe('America/New_York');
      expect(res.version).toBe(2);
      expect(redis.deleteTenantKey).toHaveBeenCalledWith(TENANT_ID, 'settings', 'active');
      expect(auditService.recordTenantEvent).toHaveBeenCalledWith(
        expect.anything(),
        mockContext,
        expect.objectContaining({
          eventType: 'TENANT_SETTINGS_UPDATED',
          resourceType: 'SETTINGS',
        }),
      );
    });
  });

  // =========================================================================
  // 5. Controller Route Handlers
  // =========================================================================
  describe('5. Controller Route Handlers', () => {
    it('TenantOnboardingController routes requests to service with verified tenantContext', async () => {
      const onboardingService = {
        getOnboardingState: jest.fn().mockResolvedValue({ tenantId: TENANT_ID }),
        updateStep: jest.fn().mockResolvedValue({ currentStep: 'ORG_SETTINGS' }),
        completeOnboarding: jest.fn().mockResolvedValue({ onboardingStatus: 'COMPLETED' }),
      } as unknown as TenantOnboardingService;

      const controller = new TenantOnboardingController(onboardingService);
      const req = { tenantContext: mockContext } as unknown as RequestWithVerifiedTenant;

      const state = await controller.getOnboardingState(req);
      expect(state.tenantId).toBe(TENANT_ID);

      const step = await controller.updateStep({ step: 'org-profile' }, { expectedVersion: 1 }, req);
      expect(step.currentStep).toBe('ORG_SETTINGS');

      const completed = await controller.completeOnboarding({ expectedVersion: 2 }, req);
      expect(completed.onboardingStatus).toBe('COMPLETED');
    });

    it('OrganizationProfileController routes requests to service', async () => {
      const profileService = {
        getProfile: jest.fn().mockResolvedValue({ tenantId: TENANT_ID }),
        updateProfile: jest.fn().mockResolvedValue({ displayName: 'Updated' }),
      } as unknown as OrganizationProfileService;

      const controller = new OrganizationProfileController(profileService);
      const req = { tenantContext: mockContext } as unknown as RequestWithVerifiedTenant;

      const profile = await controller.getProfile(req);
      expect(profile.tenantId).toBe(TENANT_ID);

      const updated = await controller.updateProfile({} as UpdateOrganizationProfileDto, req);
      expect(updated.displayName).toBe('Updated');
    });

    it('OrganizationSettingsController routes requests to service', async () => {
      const settingsService = {
        getSettings: jest.fn().mockResolvedValue({ tenantId: TENANT_ID }),
        updateSettings: jest.fn().mockResolvedValue({ timezone: 'UTC' }),
      } as unknown as OrganizationSettingsService;

      const controller = new OrganizationSettingsController(settingsService);
      const req = { tenantContext: mockContext } as unknown as RequestWithVerifiedTenant;

      const settings = await controller.getSettings(req);
      expect(settings.tenantId).toBe(TENANT_ID);

      const updated = await controller.updateSettings({} as UpdateOrganizationSettingsDto, req);
      expect(updated.timezone).toBe('UTC');
    });
  });
});
