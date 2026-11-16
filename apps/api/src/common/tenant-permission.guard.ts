import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantTransactionManager } from '../database/tenant-transaction.manager';
import { AuthAuditService } from '../modules/auth/auth-audit.service';
import { RbacRepository } from '../modules/foundation-db/rbac.repository';
import { REQUIRED_TENANT_PERMISSIONS_KEY } from './auth.decorators';
import { extractClientIp, extractUserAgent } from './http-cookie.util';
import type { RequestWithAuthSession } from './jwt-auth.guard';

/**
 * Enforces explicit `@RequirePermissions(...)` checks for single-tenant workspace
 * routes accessible to ordinary members (e.g. `tenant:organization:read`,
 * `tenant:settings:read`, `tenant:branding:read`, `tenant:members:read`).
 *
 * Fails closed (`403 INSUFFICIENT_TENANT_PERMISSIONS`) if no explicit permission
 * metadata is declared on the route or if the verified membership lacks any
 * required permission code, recording `AUTH_TENANT_PERMISSION_DENIED` in `auth_audit_logs`.
 */
@Injectable()
export class TenantPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly txManager: TenantTransactionManager,
    private readonly rbacRepo: RbacRepository,
    private readonly auditService: AuthAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithAuthSession>();
    const tenantCtx = req.tenantContext;

    if (!tenantCtx || !tenantCtx.tenantId || !tenantCtx.membershipId) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Verified active organization context is required.',
      });
    }

    const explicitRequired = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_TENANT_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!explicitRequired || explicitRequired.length === 0) {
      throw new ForbiddenException({
        code: 'MISSING_EXPLICIT_PERMISSION_MAPPING',
        message: 'Access denied: route requires an explicit tenant permission declaration.',
      });
    }

    const effectiveCodes = await this.txManager.withVerifiedMemberTransaction(
      tenantCtx,
      async (tx, verifiedMembershipId) => {
        const perms = await this.rbacRepo.listEffectivePermissionsForMembership(
          tx,
          tenantCtx.tenantId,
          verifiedMembershipId,
        );
        return perms.map((p) => p.code);
      },
    );

    req.effectiveTenantPermissions = effectiveCodes;
    const permSet = new Set(effectiveCodes);
    const authorized = explicitRequired.every((code) => permSet.has(code));

    if (!authorized) {
      await this.txManager.withVerifiedMemberTransaction(tenantCtx, async (tx) => {
        await this.auditService.record({
          eventType: 'AUTH_TENANT_PERMISSION_DENIED',
          outcome: 'DENIED',
          correlationId: tenantCtx.correlationId,
          actorUserId: tenantCtx.actorUserId,
          tenantId: tenantCtx.tenantId,
          sessionId: req.authSession?.sessionId,
          ipAddress: extractClientIp(req),
          userAgent: extractUserAgent(req),
          metadata: {
            requiredPermissions: explicitRequired,
            path: req.originalUrl || req.url,
          },
          tx,
        });
      });

      throw new ForbiddenException({
        code: 'INSUFFICIENT_TENANT_PERMISSIONS',
        message:
          'Access denied: you do not hold the required permissions in the active organization.',
      });
    }

    return true;
  }
}
