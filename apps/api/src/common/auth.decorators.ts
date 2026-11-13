import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE_KEY = 'ft360:isPublicRoute';
export const REQUIRED_TENANT_PERMISSIONS_KEY = 'ft360:requiredTenantPermissions';

/**
 * Marks a controller or handler as publicly accessible without an active authenticated session.
 * All routes without `@Public()` fail closed under the global `JwtAuthGuard`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE_KEY, true);

/**
 * Declares one or more canonical tenant-plane permission codes (e.g. `'audit:auth:read'`)
 * required by `TenantAdminGuard` within the verified active organization context.
 */
export const RequirePermissions = (...permissionCodes: string[]) =>
  SetMetadata(REQUIRED_TENANT_PERMISSIONS_KEY, permissionCodes);
