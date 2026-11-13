import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UnauthorizedTenantMembershipError } from '../database/database.types';
import { TenantTransactionManager } from '../database/tenant-transaction.manager';
import { AuthAuditService } from '../modules/auth/auth-audit.service';
import { extractClientIp, extractUserAgent } from './http-cookie.util';
import type { RequestWithAuthSession } from './jwt-auth.guard';
import { isValidUuid } from './uuid.util';

/**
 * Enforces the Platform Super Admin control-plane boundary (`/api/v1/platform/*`):
 * 1. Requires a valid authenticated user session.
 * 2. Requires `activeTenantId === null` (control-plane operations cannot execute inside a tenant session).
 * 3. Re-verifies inside PostgreSQL via `withPlatformAdminTransaction` that the actor is an
 *    `ACTIVE` user with `is_platform_super_admin = TRUE`.
 */
@Injectable()
export class PlatformSuperAdminGuard implements CanActivate {
  constructor(
    private readonly txManager: TenantTransactionManager,
    private readonly auditService: AuthAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithAuthSession>();
    const session = req.authSession;

    if (!session || !isValidUuid(session.userId)) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authenticated session is required for platform administration.',
      });
    }

    if (session.activeTenantId !== null && session.activeTenantId !== undefined) {
      await this.auditService.record({
        eventType: 'AUTH_PLATFORM_BOUNDARY_DENIED',
        outcome: 'DENIED',
        correlationId: req.correlationId,
        actorUserId: session.userId,
        sessionId: session.sessionId,
        ipAddress: extractClientIp(req),
        userAgent: extractUserAgent(req),
        metadata: {
          reason: 'ACTIVE_TENANT_SESSION_CANNOT_ACCESS_PLATFORM_PLANE',
          activeTenantId: session.activeTenantId,
          path: req.originalUrl || req.url,
        },
      });
      throw new ForbiddenException({
        code: 'PLATFORM_PLANE_REQUIRES_UNSCOPED_SESSION',
        message:
          'Platform control-plane endpoints require exiting active tenant organization context first.',
      });
    }

    try {
      await this.txManager.withPlatformAdminTransaction(session.userId, async () => true);
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedTenantMembershipError) {
        await this.auditService.record({
          eventType: 'AUTH_PLATFORM_BOUNDARY_DENIED',
          outcome: 'DENIED',
          correlationId: req.correlationId,
          actorUserId: session.userId,
          sessionId: session.sessionId,
          ipAddress: extractClientIp(req),
          userAgent: extractUserAgent(req),
          metadata: {
            reason: 'NOT_PLATFORM_SUPER_ADMIN',
            path: req.originalUrl || req.url,
          },
        });
        throw new ForbiddenException({
          code: 'PLATFORM_SUPER_ADMIN_REQUIRED',
          message: 'Access denied: Platform Super Admin privileges are required.',
        });
      }
      throw err;
    }
  }
}
