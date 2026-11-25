import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CompleteOnboardingPayload,
  OnboardingStep,
  OnboardingStepId,
  TenantOnboardingStatePayload,
  VerifiedTenantContext,
} from '@ft360/shared-types';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { TenantAuditService } from '../tenant-audit/tenant-audit.service';
import type { CompleteOnboardingDto, UpdateOnboardingStepDto } from './tenant-onboarding.dto';
import {
  TenantOnboardingRepository,
  type StepUpdateFields,
  type TenantOnboardingStateRow,
} from './tenant-onboarding.repository';

@Injectable()
export class TenantOnboardingService {
  constructor(
    private readonly repo: TenantOnboardingRepository,
    private readonly txManager: TenantTransactionManager,
    private readonly auditService: TenantAuditService,
  ) {}

  async getOnboardingState(ctx: VerifiedTenantContext): Promise<TenantOnboardingStatePayload> {
    return this.txManager.withVerifiedMemberTransaction(ctx, async (tx) => {
      const row = await this.repo.getOnboardingState(tx, ctx.tenantId);
      if (!row) {
        throw new NotFoundException({
          code: 'ONBOARDING_STATE_NOT_FOUND',
          message: 'Onboarding state not found for the active organization.',
        });
      }
      return this.mapRowToPayload(row);
    });
  }

  async updateStep(
    ctx: VerifiedTenantContext,
    stepId: OnboardingStepId,
    dto: UpdateOnboardingStepDto,
  ): Promise<TenantOnboardingStatePayload> {
    if (stepId === 'org-profile' || stepId === 'org-settings') {
      if (dto.skipped === true) {
        throw new UnprocessableEntityException({
          code: 'REQUIRED_ONBOARDING_STEP',
          message: `Onboarding step "${stepId}" is mandatory and cannot be skipped.`,
        });
      }
    }

    const nextStepMap: Record<OnboardingStepId, OnboardingStep> = {
      'org-profile': 'ORG_SETTINGS',
      'org-settings': 'ORG_BRANDING',
      'org-branding': 'TEAM_INVITES',
      'team-invites': 'REVIEW_COMPLETE',
    };

    const nextStep = nextStepMap[stepId];
    const fields: StepUpdateFields = { nextStep };
    const now = new Date();

    if (stepId === 'org-profile') {
      fields.orgProfileCompletedAt = now;
    } else if (stepId === 'org-settings') {
      fields.orgSettingsCompletedAt = now;
    } else if (stepId === 'org-branding') {
      if (dto.skipped === true) {
        fields.orgBrandingSkipped = true;
      } else {
        fields.orgBrandingCompletedAt = now;
        fields.orgBrandingSkipped = false;
      }
    } else if (stepId === 'team-invites') {
      if (dto.skipped === true) {
        fields.teamInvitesSkipped = true;
      } else {
        fields.teamInvitesCompletedAt = now;
        fields.teamInvitesSkipped = false;
      }
    }

    return this.txManager.withVerifiedMemberTransaction(ctx, async (tx) => {
      const current = await this.repo.getOnboardingState(tx, ctx.tenantId);
      if (!current) {
        throw new NotFoundException({
          code: 'ONBOARDING_STATE_NOT_FOUND',
          message: 'Onboarding state not found for the active organization.',
        });
      }

      if (current.version !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'ONBOARDING_VERSION_CONFLICT',
          message: 'Onboarding state has been updated by another process. Please reload.',
        });
      }

      const updated = await this.repo.updateStep(
        tx,
        ctx.tenantId,
        dto.expectedVersion,
        fields,
      );

      if (!updated) {
        throw new ConflictException({
          code: 'ONBOARDING_VERSION_CONFLICT',
          message: 'Onboarding state has been updated by another process. Please reload.',
        });
      }

      await this.auditService.recordTenantEvent(tx, ctx, {
        eventType: 'TENANT_ONBOARDING_STEP_SAVED',
        resourceType: 'ONBOARDING',
        resourceId: ctx.tenantId,
        metadata: {
          step: stepId,
          skipped: Boolean(dto.skipped),
          nextStep: fields.nextStep,
          version: updated.version,
        },
      });

      return this.mapRowToPayload(updated);
    });
  }

  async completeOnboarding(
    ctx: VerifiedTenantContext,
    dto: CompleteOnboardingDto,
  ): Promise<CompleteOnboardingPayload> {
    return this.txManager.withVerifiedMemberTransaction(ctx, async (tx, verifiedMembershipId) => {
      const current = await this.repo.getOnboardingState(tx, ctx.tenantId);
      if (!current) {
        throw new NotFoundException({
          code: 'ONBOARDING_STATE_NOT_FOUND',
          message: 'Onboarding state not found for the active organization.',
        });
      }

      if (current.version !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'ONBOARDING_VERSION_CONFLICT',
          message: 'Onboarding state has been updated by another process. Please reload.',
        });
      }

      if (!current.org_profile_completed_at || !current.org_settings_completed_at) {
        throw new UnprocessableEntityException({
          code: 'ONBOARDING_PREREQUISITES_INCOMPLETE',
          message:
            'Organization Profile and Regional Settings steps must be completed before onboarding can be finalized.',
        });
      }

      const completed = await this.repo.completeOnboarding(
        tx,
        ctx.tenantId,
        verifiedMembershipId,
        dto.expectedVersion,
      );

      if (!completed) {
        throw new ConflictException({
          code: 'ONBOARDING_VERSION_CONFLICT',
          message: 'Onboarding state has been updated by another process. Please reload.',
        });
      }

      await this.auditService.recordTenantEvent(tx, ctx, {
        eventType: 'TENANT_ONBOARDING_COMPLETED',
        resourceType: 'ONBOARDING',
        resourceId: ctx.tenantId,
        metadata: {
          completedByMembershipId: verifiedMembershipId,
          completedAt:
            completed.completed_at instanceof Date
              ? completed.completed_at.toISOString()
              : String(completed.completed_at),
          version: completed.version,
        },
      });

      return {
        onboardingStatus: 'COMPLETED',
        completedAt:
          completed.completed_at instanceof Date
            ? completed.completed_at.toISOString()
            : String(completed.completed_at),
        version: completed.version,
      };
    });
  }

  private mapRowToPayload(row: TenantOnboardingStateRow): TenantOnboardingStatePayload {
    return {
      tenantId: row.tenant_id,
      onboardingStatus: row.onboarding_status,
      currentStep: row.current_step,
      steps: {
        orgProfile: {
          completed: Boolean(row.org_profile_completed_at),
          completedAt: row.org_profile_completed_at
            ? (row.org_profile_completed_at instanceof Date
                ? row.org_profile_completed_at.toISOString()
                : String(row.org_profile_completed_at))
            : null,
        },
        orgSettings: {
          completed: Boolean(row.org_settings_completed_at),
          completedAt: row.org_settings_completed_at
            ? (row.org_settings_completed_at instanceof Date
                ? row.org_settings_completed_at.toISOString()
                : String(row.org_settings_completed_at))
            : null,
        },
        orgBranding: {
          completed: Boolean(row.org_branding_completed_at),
          completedAt: row.org_branding_completed_at
            ? (row.org_branding_completed_at instanceof Date
                ? row.org_branding_completed_at.toISOString()
                : String(row.org_branding_completed_at))
            : null,
          skipped: Boolean(row.org_branding_skipped),
        },
        teamInvites: {
          completed: Boolean(row.team_invites_completed_at),
          completedAt: row.team_invites_completed_at
            ? (row.team_invites_completed_at instanceof Date
                ? row.team_invites_completed_at.toISOString()
                : String(row.team_invites_completed_at))
            : null,
          skipped: Boolean(row.team_invites_skipped),
        },
      },
      completedAt: row.completed_at
        ? (row.completed_at instanceof Date
            ? row.completed_at.toISOString()
            : String(row.completed_at))
        : null,
      completedByMembershipId: row.completed_by_membership_id,
      version: row.version,
    };
  }
}
