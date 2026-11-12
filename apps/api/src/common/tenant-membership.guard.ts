import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { VerifiedTenantContext } from '@ft360/shared-types';
import type { RequestWithCorrelation } from './correlation-id.interceptor';
import { isValidUuid } from './uuid.util';

export interface AuthenticatedSessionIdentity {
  userId: string;
  activeTenantId: string;
}

export interface TenantMembershipRecord {
  membershipId: string;
  tenantId: string;
  userId: string;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REVOKED';
  tenantStatus: 'ACTIVE' | 'TRIAL' | 'SUSPENDED' | 'CANCELLED';
}

export interface TenantMembershipVerifier {
  findMembership(userId: string, tenantId: string): Promise<TenantMembershipRecord | null>;
}

export const TENANT_MEMBERSHIP_VERIFIER = Symbol('TENANT_MEMBERSHIP_VERIFIER');

export interface RequestWithVerifiedTenant extends RequestWithCorrelation {
  authSession?: AuthenticatedSessionIdentity;
  tenantContext?: VerifiedTenantContext;
}

/**
 * Enforces that an authenticated user possesses an ACTIVE membership in an ACTIVE/TRIAL
 * tenant before any workspace controller or TenantTransactionManager operation can execute.
 * Prevents access through wrong, revoked, or suspended tenant memberships.
 */
@Injectable()
export class TenantMembershipGuard implements CanActivate {
  constructor(
    @Inject(TENANT_MEMBERSHIP_VERIFIER)
    private readonly membershipVerifier: TenantMembershipVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithVerifiedTenant>();
    const session = req.authSession;

    if (!session || !isValidUuid(session.userId) || !isValidUuid(session.activeTenantId)) {
      throw new UnauthorizedException({
        code: 'MISSING_OR_INVALID_AUTH_SESSION',
        message: 'Authenticated session with a valid active tenant context is required.',
      });
    }

    const userId = session.userId.trim().toLowerCase();
    const tenantId = session.activeTenantId.trim().toLowerCase();

    const membership = await this.membershipVerifier.findMembership(userId, tenantId);
    if (!membership) {
      throw new ForbiddenException({
        code: 'TENANT_MEMBERSHIP_DENIED',
        message: 'Access denied: user is not a member of the target organization.',
      });
    }

    if (membership.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'TENANT_MEMBERSHIP_INACTIVE',
        message: `Access denied: membership status is ${membership.status}.`,
      });
    }

    if (membership.tenantStatus !== 'ACTIVE' && membership.tenantStatus !== 'TRIAL') {
      throw new ForbiddenException({
        code: 'TENANT_SUSPENDED_OR_INACTIVE',
        message: `Access denied: organization status is ${membership.tenantStatus}.`,
      });
    }

    req.tenantContext = Object.freeze({
      tenantId,
      actorUserId: userId,
      membershipId: membership.membershipId,
      correlationId: req.correlationId ?? '00000000-0000-0000-0000-000000000000',
    });

    return true;
  }
}

