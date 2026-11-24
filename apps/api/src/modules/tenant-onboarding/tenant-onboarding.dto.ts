import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  Min,
} from 'class-validator';
import type {
  CompleteOnboardingRequest,
  OnboardingStepId,
  UpdateOnboardingStepPayload,
} from '@ft360/shared-types';

export const ALLOWED_ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  'org-profile',
  'org-settings',
  'org-branding',
  'team-invites',
] as const;

export class OnboardingStepParamDto {
  @ApiProperty({
    description: 'Onboarding step identifier',
    enum: ALLOWED_ONBOARDING_STEPS,
    example: 'org-profile',
  })
  @IsNotEmpty()
  @IsIn(ALLOWED_ONBOARDING_STEPS, {
    message: 'step must be one of: org-profile, org-settings, org-branding, team-invites',
  })
  step!: OnboardingStepId;
}

export class UpdateOnboardingStepDto implements UpdateOnboardingStepPayload {
  @ApiPropertyOptional({
    description: 'Whether to skip this step (allowed for org-branding and team-invites only)',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skipped?: boolean;

  @ApiPropertyOptional({
    description: 'Step-specific payload data',
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiProperty({
    description: 'Expected current version of the onboarding state for optimistic concurrency control',
    example: 1,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class CompleteOnboardingDto implements CompleteOnboardingRequest {
  @ApiProperty({
    description: 'Expected current version of the onboarding state for optimistic concurrency control',
    example: 2,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
