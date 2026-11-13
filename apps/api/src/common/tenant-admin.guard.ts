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

const DEFAULT_TENANT_ADMIN_ANY_OF = [
  'tenant:organization:manage',
  'rbac:roles:manage',
  'tenant:members:manage',
  'audit:auth:read',
];

/**
 * Enforces the Tenant Admin authorization boundary (`/api/v1/workspace/admin/*`).
 * Must run AFTER `TenantMembershipGuard` so `req.tenantContext` is already server-verified.
 * Evaluates effective RBAC permissions strictly inside `req.tenantContext.tenantId`.
 */
@Injectable()
export class TenantAdminGuard implements CanActivate {
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

    const authorized =
      explicitRequired && explicitRequired.length > 0
        ? explicitRequired.every((code) => permSet.has(code))
        : DEFAULT_TENANT_ADMIN_ANY_OF.some((code) => permSet.has(code));

    if (!authorized) {
      await this.txManager.withVerifiedMemberTransaction(tenantCtx, async (tx) => {
        await this.auditService.record({
          eventType: 'AUTH_TENANT_ADMIN_BOUNDARY_DENIED',
          outcome: 'DENIED',
          correlationId: tenantCtx.correlationId,
          actorUserId: tenantCtx.actorUserId,
          tenantId: tenantCtx.tenantId,
          sessionId: req.authSession?.sessionId,
          ipAddress: extractClientIp(req),
          userAgent: extractUserAgent(req),
          metadata: {
            requiredPermissions: explicitRequired ?? DEFAULT_TENANT_ADMIN_ANY_OF,
            path: req.originalUrl || req.url,
          },
          tx,
        });
      });

      throw new ForbiddenException({
        code: 'INSUFFICIENT_TENANT_PERMISSIONS',
        message:
          'Access denied: you do not hold required administrative permissions in the active organization.',
      });
    }

    return true;
  }
}
