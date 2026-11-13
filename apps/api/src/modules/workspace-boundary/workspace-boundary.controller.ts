import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AuthAuditLogEntry,
  MembershipStatus,
  MembershipType,
  TenantStatus,
  WorkspaceBoundaryContextPayload,
} from '@ft360/shared-types';
import { RequirePermissions } from '../../common/auth.decorators';
import type { RequestWithAuthSession } from '../../common/jwt-auth.guard';
import { TenantAdminGuard } from '../../common/tenant-admin.guard';
import { TenantMembershipGuard } from '../../common/tenant-membership.guard';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { AuthRepository } from '../auth/auth.repository';
import { RbacRepository } from '../foundation-db/rbac.repository';

const ADMIN_ANY_CODES = new Set([
  'tenant:organization:manage',
  'rbac:roles:manage',
  'tenant:members:manage',
  'audit:auth:read',
]);

@ApiTags('Workspace Boundary (Tenant Plane)')
@Controller('workspace')
export class WorkspaceBoundaryController {
  constructor(
    private readonly txManager: TenantTransactionManager,
    private readonly rbacRepo: RbacRepository,
    private readonly authRepo: AuthRepository,
  ) {}

  @UseGuards(TenantMembershipGuard)
  @Get('context')
  @ApiOperation({
    summary: 'Verify authenticated tenant membership boundary and retrieve active workspace context',
  })
  async getWorkspaceContext(
    @Req() req: RequestWithAuthSession,
  ): Promise<WorkspaceBoundaryContextPayload> {
    const ctx = req.tenantContext!;

    return this.txManager.withVerifiedMemberTransaction(ctx, async (tx, verifiedMembershipId) => {
      const orgRes = await tx.query<{
        tenant_id: string;
        tenant_slug: string;
        tenant_display_name: string;
        tenant_status: TenantStatus;
        membership_type: MembershipType;
        membership_status: MembershipStatus;
      }>(
        `SELECT
           t.id AS tenant_id,
           t.slug::text AS tenant_slug,
           t.display_name AS tenant_display_name,
           t.status AS tenant_status,
           tm.membership_type,
           tm.status AS membership_status
         FROM public.tenants t
         INNER JOIN public.tenant_memberships tm
           ON tm.tenant_id = t.id AND tm.id = $2::uuid
         WHERE t.id = $1::uuid`,
        [ctx.tenantId, verifiedMembershipId],
      );

      const orgRow = orgRes.rows[0];
      const perms = await this.rbacRepo.listEffectivePermissionsForMembership(
        tx,
        ctx.tenantId,
        verifiedMembershipId,
      );
      const codes = perms.map((p) => p.code);

      return {
        tenantId: ctx.tenantId,
        membershipId: verifiedMembershipId,
        actorUserId: ctx.actorUserId,
        organization: {
          membershipId: verifiedMembershipId,
          tenantId: orgRow.tenant_id,
          tenantSlug: orgRow.tenant_slug,
          tenantDisplayName: orgRow.tenant_display_name,
          tenantStatus: orgRow.tenant_status,
          membershipType: orgRow.membership_type,
          membershipStatus: orgRow.membership_status,
        },
        effectivePermissions: codes,
        isTenantAdmin: codes.some((c) => ADMIN_ANY_CODES.has(c)),
      };
    });
  }

  @UseGuards(TenantMembershipGuard, TenantAdminGuard)
  @Get('admin/auth-logs')
  @ApiOperation({
    summary: 'Tenant Admin boundary: view tenant-isolated authentication & authorization audit logs',
  })
  async listTenantAuthLogs(
    @Req() req: RequestWithAuthSession,
    @Query('limit') limitRaw?: string,
  ): Promise<AuthAuditLogEntry[]> {
    const ctx = req.tenantContext!;
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(200, Math.max(1, parsedLimit)) : 50;

    return this.txManager.withVerifiedMemberTransaction(ctx, (tx) =>
      this.authRepo.listAuditLogsInScope(tx, safeLimit),
    );
  }

  @UseGuards(TenantMembershipGuard, TenantAdminGuard)
  @RequirePermissions('rbac:roles:manage')
  @Get('admin/rbac-posture')
  @ApiOperation({
    summary: 'Tenant Admin explicit permission boundary (`rbac:roles:manage`)',
  })
  async getRbacPosture(@Req() req: RequestWithAuthSession) {
    const ctx = req.tenantContext!;
    return this.txManager.withVerifiedMemberTransaction(ctx, async (tx) => {
      const roles = await this.rbacRepo.listRoles(tx, ctx.tenantId);
      return {
        tenantId: ctx.tenantId,
        roleCount: roles.length,
        roles,
      };
    });
  }
}
