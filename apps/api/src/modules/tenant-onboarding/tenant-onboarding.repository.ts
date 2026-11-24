import { Injectable } from '@nestjs/common';
import type { OnboardingStatus, OnboardingStep } from '@ft360/shared-types';
import type { QueryExecutor } from '../../database/database.types';

export interface TenantOnboardingStateRow {
  tenant_id: string;
  onboarding_status: OnboardingStatus;
  current_step: OnboardingStep;
  org_profile_completed_at: Date | string | null;
  org_settings_completed_at: Date | string | null;
  org_branding_completed_at: Date | string | null;
  org_branding_skipped: boolean;
  team_invites_completed_at: Date | string | null;
  team_invites_skipped: boolean;
  completed_at: Date | string | null;
  completed_by_membership_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StepUpdateFields {
  nextStep: OnboardingStep;
  orgProfileCompletedAt?: Date | null;
  orgSettingsCompletedAt?: Date | null;
  orgBrandingCompletedAt?: Date | null;
  orgBrandingSkipped?: boolean;
  teamInvitesCompletedAt?: Date | null;
  teamInvitesSkipped?: boolean;
}

@Injectable()
export class TenantOnboardingRepository {
  async getOnboardingState(
    tx: QueryExecutor,
    tenantId: string,
  ): Promise<TenantOnboardingStateRow | null> {
    const res = await tx.query<TenantOnboardingStateRow>(
      `SELECT
         tenant_id,
         onboarding_status,
         current_step,
         org_profile_completed_at,
         org_settings_completed_at,
         org_branding_completed_at,
         org_branding_skipped,
         team_invites_completed_at,
         team_invites_skipped,
         completed_at,
         completed_by_membership_id,
         version,
         created_at,
         updated_at
       FROM public.tenant_onboarding_states
       WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  async updateStep(
    tx: QueryExecutor,
    tenantId: string,
    expectedVersion: number,
    fields: StepUpdateFields,
  ): Promise<TenantOnboardingStateRow | null> {
    const res = await tx.query<TenantOnboardingStateRow>(
      `UPDATE public.tenant_onboarding_states
       SET
         current_step = $3,
         org_profile_completed_at = COALESCE($4, org_profile_completed_at),
         org_settings_completed_at = COALESCE($5, org_settings_completed_at),
         org_branding_completed_at = COALESCE($6, org_branding_completed_at),
         org_branding_skipped = COALESCE($7, org_branding_skipped),
         team_invites_completed_at = COALESCE($8, team_invites_completed_at),
         team_invites_skipped = COALESCE($9, team_invites_skipped),
         version = version + 1,
         updated_at = NOW()
       WHERE tenant_id = $1::uuid AND version = $2
       RETURNING
         tenant_id,
         onboarding_status,
         current_step,
         org_profile_completed_at,
         org_settings_completed_at,
         org_branding_completed_at,
         org_branding_skipped,
         team_invites_completed_at,
         team_invites_skipped,
         completed_at,
         completed_by_membership_id,
         version,
         created_at,
         updated_at`,
      [
        tenantId,
        expectedVersion,
        fields.nextStep,
        fields.orgProfileCompletedAt ?? null,
        fields.orgSettingsCompletedAt ?? null,
        fields.orgBrandingCompletedAt ?? null,
        fields.orgBrandingSkipped ?? null,
        fields.teamInvitesCompletedAt ?? null,
        fields.teamInvitesSkipped ?? null,
      ],
    );
    return res.rows[0] ?? null;
  }

  async completeOnboarding(
    tx: QueryExecutor,
    tenantId: string,
    membershipId: string,
    expectedVersion: number,
  ): Promise<TenantOnboardingStateRow | null> {
    const res = await tx.query<TenantOnboardingStateRow>(
      `UPDATE public.tenant_onboarding_states
       SET
         onboarding_status = 'COMPLETED',
         current_step = 'REVIEW_COMPLETE',
         completed_at = NOW(),
         completed_by_membership_id = $3::uuid,
         version = version + 1,
         updated_at = NOW()
       WHERE tenant_id = $1::uuid
         AND version = $2
         AND org_profile_completed_at IS NOT NULL
         AND org_settings_completed_at IS NOT NULL
       RETURNING
         tenant_id,
         onboarding_status,
         current_step,
         org_profile_completed_at,
         org_settings_completed_at,
         org_branding_completed_at,
         org_branding_skipped,
         team_invites_completed_at,
         team_invites_skipped,
         completed_at,
         completed_by_membership_id,
         version,
         created_at,
         updated_at`,
      [tenantId, expectedVersion, membershipId],
    );

    const row = res.rows[0];
    if (row) {
      await tx.query(
        `UPDATE public.tenants
         SET onboarding_completed_at = NOW(), updated_at = NOW()
         WHERE id = $1::uuid`,
        [tenantId],
      );
    }

    return row ?? null;
  }
}
