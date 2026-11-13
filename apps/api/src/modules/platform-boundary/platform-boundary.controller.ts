import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthAuditLogEntry, PlatformAuthOverviewPayload } from '@ft360/shared-types';
import type { RequestWithAuthSession } from '../../common/jwt-auth.guard';
import { PlatformSuperAdminGuard } from '../../common/platform-super-admin.guard';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { AuthRepository } from '../auth/auth.repository';

@ApiTags('Platform Control Plane (Super Admin Only)')
@UseGuards(PlatformSuperAdminGuard)
@Controller('platform')
export class PlatformBoundaryController {
  constructor(
    private readonly txManager: TenantTransactionManager,
    private readonly authRepo: AuthRepository,
  ) {}

  @Get('auth/overview')
  @ApiOperation({
    summary: 'Platform Super Admin control-plane boundary overview',
  })
  async getOverview(
    @Req() req: RequestWithAuthSession,
  ): Promise<PlatformAuthOverviewPayload> {
    const actorUserId = req.authSession!.userId;

    return this.txManager.withPlatformAdminTransaction(actorUserId, async (tx) => {
      const res = await tx.query<{
        total_users: string;
        active_users: string;
        pending_users: string;
        active_tenants: string;
        active_sessions: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM public.users) AS total_users,
           (SELECT COUNT(*)::text FROM public.users WHERE status = 'ACTIVE') AS active_users,
           (SELECT COUNT(*)::text FROM public.users WHERE status = 'PENDING') AS pending_users,
           (SELECT COUNT(*)::text FROM public.tenants WHERE status IN ('ACTIVE', 'TRIAL')) AS active_tenants,
           (SELECT COUNT(*)::text FROM public.auth_sessions WHERE revoked_at IS NULL AND expires_at > NOW() AND idle_expires_at > NOW()) AS active_sessions`,
      );
      const row = res.rows[0];

      return {
        actorUserId,
        plane: 'PLATFORM_CONTROL_PLANE',
        metrics: {
          totalUsers: Number.parseInt(row.total_users, 10),
          activeUsers: Number.parseInt(row.active_users, 10),
          pendingUsers: Number.parseInt(row.pending_users, 10),
          activeTenants: Number.parseInt(row.active_tenants, 10),
          activeSessions: Number.parseInt(row.active_sessions, 10),
        },
      };
    });
  }

  @Get('audit/auth-logs')
  @ApiOperation({
    summary: 'Platform Super Admin boundary: view global & cross-plane authentication audit logs',
  })
  async listPlatformAuthLogs(
    @Req() req: RequestWithAuthSession,
    @Query('limit') limitRaw?: string,
  ): Promise<AuthAuditLogEntry[]> {
    const actorUserId = req.authSession!.userId;
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(200, Math.max(1, parsedLimit)) : 50;

    return this.txManager.withPlatformAdminTransaction(actorUserId, (tx) =>
      this.authRepo.listAuditLogsInScope(tx, safeLimit),
    );
  }
}
