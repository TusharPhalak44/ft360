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
import type { TenantSettingsPayload } from '@ft360/shared-types';
import { RequirePermissions } from '../../common/auth.decorators';
import { TenantAdminGuard } from '../../common/tenant-admin.guard';
import {
  TenantMembershipGuard,
  type RequestWithVerifiedTenant,
} from '../../common/tenant-membership.guard';
import { TenantPermissionGuard } from '../../common/tenant-permission.guard';
import { UpdateOrganizationSettingsDto } from './organization-settings.dto';
import { OrganizationSettingsService } from './organization-settings.service';

@ApiTags('Organization Settings (Workspace Plane)')
@ApiBearerAuth()
@Controller('workspace/organization/settings')
export class OrganizationSettingsController {
  constructor(private readonly settingsService: OrganizationSettingsService) {}

  /**
   * Endpoint #8: Retrieves the organization settings for the active tenant (cache-aside with Redis).
   */
  @Get('')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantMembershipGuard, TenantPermissionGuard)
  @RequirePermissions('tenant:settings:read')
  @ApiOperation({
    summary: 'Get organization regional, localization, and governance settings',
    description:
      'Retrieves timezone, locale, formats, currency, invitation TTL, member directory view setting, and optimistic version. Served via Redis cache-aside with PostgreSQL fail-safe.',
  })
  @ApiOkResponse({
    description: 'Organization settings retrieved successfully',
  })
  async getSettings(
    @Req() req: RequestWithVerifiedTenant,
  ): Promise<TenantSettingsPayload> {
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }
    return this.settingsService.getSettings(ctx);
  }

  /**
   * Endpoint #9: Updates organization settings with optimistic concurrency control and cache invalidation.
   */
  @Put('')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantMembershipGuard, TenantAdminGuard)
  @RequirePermissions('tenant:settings:manage')
  @ApiOperation({
    summary: 'Update organization regional, localization, and governance settings',
    description:
      'Updates organization settings, synchronizes tenant defaults, invalidates Redis cache, and emits audit event. Requires tenant:settings:manage permission.',
  })
  @ApiOkResponse({
    description: 'Organization settings updated successfully',
  })
  @ApiConflictResponse({
    description: 'Version conflict (expectedVersion does not match current state)',
  })
  async updateSettings(
    @Body() dto: UpdateOrganizationSettingsDto,
    @Req() req: RequestWithVerifiedTenant,
  ): Promise<TenantSettingsPayload> {
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }
    return this.settingsService.updateSettings(ctx, dto);
  }
}
