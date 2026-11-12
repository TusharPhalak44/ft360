import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

export const ALLOW_EXPLICIT_TENANT_TARGET_KEY = 'allowExplicitTenantTarget';

/**
 * Only specialized routes (such as verified `/auth/switch-tenant` in Phase 3
 * or Platform Super Admin management routes) may opt into accepting a target
 * tenant identifier, which they must then verify against server-side memberships/RBAC.
 */
export const AllowExplicitTenantTarget = () => SetMetadata(ALLOW_EXPLICIT_TENANT_TARGET_KEY, true);

const FORBIDDEN_TENANT_HEADERS = ['x-tenant-id', 'x-tenant-slug', 'x-org-id'];
const FORBIDDEN_TENANT_KEYS = new Set(['tenantId', 'tenant_id']);

function containsForbiddenKey(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => containsForbiddenKey(item));
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TENANT_KEYS.has(key)) {
      return true;
    }
    if (typeof record[key] === 'object' && record[key] !== null && containsForbiddenKey(record[key])) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class UntrustedTenantInputGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowTarget = this.reflector.getAllAndOverride<boolean>(ALLOW_EXPLICIT_TENANT_TARGET_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowTarget) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();

    for (const headerName of FORBIDDEN_TENANT_HEADERS) {
      if (req.headers[headerName] !== undefined) {
        throw new BadRequestException({
          code: 'UNTRUSTED_TENANT_INPUT_REJECTED',
          message: `Client-supplied header "${headerName}" is prohibited. Tenant context is derived exclusively from verified server-side session membership.`,
        });
      }
    }

    if (containsForbiddenKey(req.query) || containsForbiddenKey(req.body)) {
      throw new BadRequestException({
        code: 'UNTRUSTED_TENANT_INPUT_REJECTED',
        message:
          'Client-supplied tenant_id / tenantId parameter is prohibited. Tenant context is derived exclusively from verified server-side session membership.',
      });
    }

    return true;
  }
}

