import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantAuditLogPagePayload } from '@ft360/shared-types';
import { RequirePermissions } from '../../common/auth.decorators';
import type { RequestWithAuthSession } from '../../common/jwt-auth.guard';
import { TenantAdminGuard } from '../../common/tenant-admin.guard';
import { TenantMembershipGuard } from '../../common/tenant-membership.guard';
import { ListTenantAuditLogsQueryDto } from './tenant-audit.dto';
import { TenantAuditService } from './tenant-audit.service';

@ApiTags('Tenant Domain Audit Logs (Workspace Plane)')
@Controller('workspace/audit-logs')
@UseGuards(TenantMembershipGuard, TenantAdminGuard)
export class TenantAuditController {
  constructor(private readonly tenantAuditService: TenantAuditService) {}

  @Get()
  @RequirePermissions('audit:tenant:read')
  @ApiOperation({
    summary:
      'Endpoint #29: Query append-only tenant domain governance & state-diff audit logs within the active organization',
  })
  async listWorkspaceAuditLogs(
    @Req() req: RequestWithAuthSession,
    @Query() query: ListTenantAuditLogsQueryDto,
  ): Promise<TenantAuditLogPagePayload> {
    return this.tenantAuditService.listWorkspaceAuditLogs(req.tenantContext!, query);
  }
}
