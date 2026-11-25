import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type {
  CompleteOnboardingPayload,
  TenantOnboardingStatePayload,
} from '@ft360/shared-types';
import { RequirePermissions } from '../../common/auth.decorators';
import { TenantAdminGuard } from '../../common/tenant-admin.guard';
import {
  TenantMembershipGuard,
  type RequestWithVerifiedTenant,
} from '../../common/tenant-membership.guard';
import { TenantPermissionGuard } from '../../common/tenant-permission.guard';
import {
  CompleteOnboardingDto,
  OnboardingStepParamDto,
  UpdateOnboardingStepDto,
} from './tenant-onboarding.dto';
import { TenantOnboardingService } from './tenant-onboarding.service';

@ApiTags('Tenant Onboarding (Workspace Plane)')
@ApiBearerAuth()
@Controller('workspace/onboarding')
export class TenantOnboardingController {
  constructor(private readonly onboardingService: TenantOnboardingService) {}

  /**
   * Endpoint #3: Retrieves the 4-step onboarding state for the active tenant.
   */
  @Get('')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantMembershipGuard, TenantPermissionGuard)
  @RequirePermissions('tenant:organization:read')
  @ApiOperation({
    summary: 'Get 4-step onboarding status and optimistic lock version',
    description:
      'Retrieves the current onboarding step, completion status, skipped flags, and optimistic version for the active organization.',
  })
  @ApiOkResponse({
    description: 'Current onboarding state retrieved successfully',
  })
  async getOnboardingState(
    @Req() req: RequestWithVerifiedTenant,
  ): Promise<TenantOnboardingStatePayload> {
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }
    return this.onboardingService.getOnboardingState(ctx);
  }

  /**
   * Endpoint #4: Saves step data or marks optional step skipped; advances current step.
   */
  @Patch('steps/:step')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantMembershipGuard, TenantAdminGuard)
  @RequirePermissions('tenant:organization:manage')
  @ApiOperation({
    summary: 'Save onboarding step payload or mark optional step skipped',
    description:
      'Saves step payload for org-profile, org-settings, org-branding, or team-invites. Mandatory steps (org-profile, org-settings) cannot be skipped.',
  })
  @ApiOkResponse({
    description: 'Onboarding step updated and advanced successfully',
  })
  @ApiConflictResponse({
    description: 'Version conflict (expectedVersion does not match current state)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Attempted to skip a mandatory onboarding step',
  })
  async updateStep(
    @Param() params: OnboardingStepParamDto,
    @Body() dto: UpdateOnboardingStepDto,
    @Req() req: RequestWithVerifiedTenant,
  ): Promise<TenantOnboardingStatePayload> {
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }
    return this.onboardingService.updateStep(ctx, params.step, dto);
  }

  /**
   * Endpoint #5: Validates required steps and finalizes tenant onboarding.
   */
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantMembershipGuard, TenantAdminGuard)
  @RequirePermissions('tenant:organization:manage')
  @ApiOperation({
    summary: 'Finalize onboarding status and record completion',
    description:
      'Validates that required steps (org-profile, org-settings) are complete, transitions onboarding_status to COMPLETED, and sets tenants.onboarding_completed_at.',
  })
  @ApiOkResponse({
    description: 'Onboarding finalized successfully',
  })
  @ApiConflictResponse({
    description: 'Version conflict',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Required onboarding steps are incomplete',
  })
  async completeOnboarding(
    @Body() dto: CompleteOnboardingDto,
    @Req() req: RequestWithVerifiedTenant,
  ): Promise<CompleteOnboardingPayload> {
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }
    return this.onboardingService.completeOnboarding(ctx, dto);
  }
}
