import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
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
} from '@nestjs/swagger';
import type { OrganizationProfilePayload } from '@ft360/shared-types';
import { RequirePermissions } from '../../common/auth.decorators';
import { TenantAdminGuard } from '../../common/tenant-admin.guard';
import {
  TenantMembershipGuard,
  type RequestWithVerifiedTenant,
} from '../../common/tenant-membership.guard';
import { TenantPermissionGuard } from '../../common/tenant-permission.guard';
import { UpdateOrganizationProfileDto } from './organization-profile.dto';
import { OrganizationProfileService } from './organization-profile.service';

@ApiTags('Organization Profile (Workspace Plane)')
@ApiBearerAuth()
@Controller('workspace/organization/profile')
export class OrganizationProfileController {
  constructor(private readonly profileService: OrganizationProfileService) {}

  /**
   * Endpoint #6: Retrieves the organization profile for the active tenant.
   */
  @Get('')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantMembershipGuard, TenantPermissionGuard)
  @RequirePermissions('tenant:organization:read')
  @ApiOperation({
    summary: 'Get organization profile and companion details',
    description:
      'Retrieves the joined tenant identity, registration details, addresses, contacts, and optimistic version for the active organization.',
  })
  @ApiOkResponse({
    description: 'Organization profile retrieved successfully',
  })
  async getProfile(
    @Req() req: RequestWithVerifiedTenant,
  ): Promise<OrganizationProfilePayload> {
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }
    return this.profileService.getProfile(ctx);
  }

  /**
   * Endpoint #7: Updates organization profile fields with optimistic concurrency control.
   */
  @Put('')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantMembershipGuard, TenantAdminGuard)
  @RequirePermissions('tenant:organization:manage')
  @ApiOperation({
    summary: 'Update organization profile and legal identity',
    description:
      'Updates organization profile and companion tenant fields. Requires tenant:organization:manage permission and matches optimistic version.',
  })
  @ApiOkResponse({
    description: 'Organization profile updated successfully',
  })
  @ApiConflictResponse({
    description: 'Version conflict (expectedVersion does not match current state)',
  })
  async updateProfile(
    @Body() dto: UpdateOrganizationProfileDto,
    @Req() req: RequestWithVerifiedTenant,
  ): Promise<OrganizationProfilePayload> {
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }
    return this.profileService.updateProfile(ctx, dto);
  }
}
