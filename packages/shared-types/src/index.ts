export interface ApiMeta {
  correlationId: string;
  timestamp: string;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiFieldError {
  field?: string;
  issue: string;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: ApiFieldError[];
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorPayload;
  meta: ApiMeta;
}

export interface ProductBrandingConfig {
  productName: string;
  tagline: string;
  supportEmail: string;
  websiteUrl: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  primaryColorHex: string;
  accentColorHex: string;
  source: 'TENANT' | 'PLATFORM' | 'BOOTSTRAP_DEFAULT';
}

export interface DatabasePoolHealth {
  connected: boolean;
  latencyMs: number;
  serverVersion: string;
  currentRole: string;
  bypassRls: boolean;
  isSuperuser: boolean;
  appliedMigrations: number;
  pool: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
}

export interface RedisHealth {
  connected: boolean;
  latencyMs: number;
  mode: string;
}

export interface SystemHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  service: string;
  environment: string;
  uptimeSeconds: number;
  database: DatabasePoolHealth;
  redis: RedisHealth;
}

/**
 * Server-verified tenant execution context.
 * MUST ONLY be constructed by backend authentication + membership guards,
 * NEVER directly from untrusted client headers, query params, or request bodies.
 */
export interface VerifiedTenantContext {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly membershipId?: string;
  readonly correlationId: string;
}

// =============================================================================
// Phase 2 – Foundational Multi-Tenant Database Domain Types
// =============================================================================

export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export type TenantStatus =
  | 'PROVISIONING'
  | 'TRIAL'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'DEACTIVATED'
  | 'CANCELLED';

export type MembershipType = 'INTERNAL' | 'CLIENT_PORTAL' | 'PARTNER';

export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export type PermissionScopePlane = 'PLATFORM' | 'TENANT' | 'PORTAL';

export type DataAccessScope = 'OWN' | 'TEAM' | 'TENANT';

export interface UserEntity {
  id: string;
  email: string;
  fullName: string;
  phoneE164: string | null;
  status: UserStatus;
  isPlatformSuperAdmin: boolean;
  emailVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantEntity {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  status: TenantStatus;
  defaultTimezone: string;
  defaultCurrency: string;
  activatedAt: string | null;
  suspendedAt: string | null;
  deactivatedAt?: string | null;
  cancelledAt?: string | null;
  statusReason?: string | null;
  onboardingCompletedAt?: string | null;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantMembershipEntity {
  id: string;
  tenantId: string;
  userId: string;
  membershipType: MembershipType;
  status: MembershipStatus;
  isPrimaryOwner?: boolean;
  jobTitle: string | null;
  employeeCode: string | null;
  invitedByUserId: string | null;
  joinedAt: string | null;
  suspendedAt?: string | null;
  revokedAt?: string | null;
  statusReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionEntity {
  id: string;
  code: string;
  scopePlane: PermissionScopePlane;
  moduleCode: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoleEntity {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  isSystemRole: boolean;
  dataAccessScope: DataAccessScope;
  createdAt: string;
  updatedAt: string;
}

export interface RolePermissionEntity {
  id: string;
  tenantId: string;
  roleId: string;
  permissionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserRoleAssignmentEntity {
  id: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  assignedByMembershipId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveUserTenantSummary {
  membershipId: string;
  tenantId: string;
  tenantSlug: string;
  tenantDisplayName: string;
  tenantStatus: TenantStatus;
  membershipType: MembershipType;
  membershipStatus: MembershipStatus;
}

// =============================================================================
// Phase 3 – Authentication, Session Management & Plane Boundary Contracts
// =============================================================================

export type AuthAuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED';

export interface AuthenticatedUserProfile {
  id: string;
  email: string;
  fullName: string;
  phoneE164: string | null;
  status: UserStatus;
  emailVerified: boolean;
  isPlatformSuperAdmin: boolean;
  lastLoginAt: string | null;
}

export interface AuthSessionSummary {
  id: string;
  familyId: string;
  userId: string;
  activeTenantId: string | null;
  activeMembershipId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  lastActiveAt: string;
  idleExpiresAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  isCurrent: boolean;
  createdAt: string;
}

export interface RegisterUserResponsePayload {
  user: AuthenticatedUserProfile;
  verificationRequired: true;
}

export interface LoginResponsePayload {
  user: AuthenticatedUserProfile;
  sessionId: string;
  activeOrganization: ActiveUserTenantSummary | null;
  organizations: ActiveUserTenantSummary[];
  requiresOrganizationSelection: boolean;
}

export interface AuthMeResponsePayload {
  user: AuthenticatedUserProfile;
  sessionId: string;
  activeOrganization: ActiveUserTenantSummary | null;
  organizations: ActiveUserTenantSummary[];
  requiresOrganizationSelection: boolean;
  effectiveTenantPermissions: string[];
}

export interface SelectOrganizationResponsePayload {
  sessionId: string;
  activeOrganization: ActiveUserTenantSummary | null;
  effectiveTenantPermissions: string[];
}

export interface AuthAuditLogEntry {
  id: string;
  eventType: string;
  outcome: AuthAuditOutcome;
  actorUserId: string | null;
  targetUserId: string | null;
  tenantId: string | null;
  sessionId: string | null;
  correlationId: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WorkspaceBoundaryContextPayload {
  tenantId: string;
  membershipId: string;
  actorUserId: string;
  organization: ActiveUserTenantSummary;
  effectivePermissions: string[];
  isTenantAdmin: boolean;
}

export interface PlatformAuthOverviewPayload {
  actorUserId: string;
  plane: 'PLATFORM_CONTROL_PLANE';
  metrics: {
    totalUsers: number;
    activeUsers: number;
    pendingUsers: number;
    activeTenants: number;
    activeSessions: number;
  };
}

// =============================================================================
// Phase 4 (Stage 4A) – Tenant Domain Governance & State-Diff Audit Contracts
// =============================================================================

export type TenantAuditOutcome = 'SUCCESS' | 'FAILURE' | 'DENIED';

export type TenantAuditActorPlane = 'TENANT' | 'PLATFORM' | 'USER_ONBOARDING';

export type TenantAuditResourceType =
  | 'TENANT'
  | 'ONBOARDING'
  | 'PROFILE'
  | 'SETTINGS'
  | 'BRANDING'
  | 'INVITATION'
  | 'MEMBERSHIP'
  | 'ROLE_ASSIGNMENT';

export interface TenantAuditLogEntry {
  id: string;
  tenantId: string;
  eventType: string;
  resourceType: TenantAuditResourceType;
  resourceId: string | null;
  outcome: TenantAuditOutcome;
  actorPlane: TenantAuditActorPlane;
  actorUserId: string | null;
  actorMembershipId: string | null;
  reason: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  correlationId: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface TenantAuditLogPagePayload {
  items: TenantAuditLogEntry[];
  nextCursor: string | null;
}

// =============================================================================
// Phase 4 (Stage 4B) – Tenant Registration & Onboarding Contracts
// =============================================================================

export type OrganizationType =
  | 'COMPANY'
  | 'AGENCY'
  | 'ENTERPRISE'
  | 'NONPROFIT'
  | 'GOVERNMENT'
  | 'SOLE_PROPRIETORSHIP'
  | 'PARTNERSHIP'
  | 'OTHER';

export type IndustryCode =
  | 'SAAS_TECHNOLOGY'
  | 'MARKETING_AGENCY'
  | 'FINANCE_FINTECH'
  | 'HEALTHCARE'
  | 'ECOMMERCE_RETAIL'
  | 'REAL_ESTATE'
  | 'EDUCATION'
  | 'MANUFACTURING'
  | 'CONSULTING'
  | 'LOGISTICS'
  | 'OTHER';

export interface CheckSlugAvailabilityQuery {
  slug: string;
}

export interface CheckSlugAvailabilityResponsePayload {
  slug: string;
  available: boolean;
}

export interface TenantRegistrationRequestPayload {
  displayName: string;
  legalName: string;
  slug: string;
  organizationType: OrganizationType;
  industry: IndustryCode;
  countryCode: string;
  defaultTimezone: string;
  defaultCurrency: string;
}

export interface TenantRegistrationResponsePayload {
  tenant: TenantEntity;
  membership: {
    id: string;
    membershipType: MembershipType;
    status: MembershipStatus;
    isPrimaryOwner: boolean;
  };
  onboarding: {
    onboardingStatus: 'IN_PROGRESS' | 'COMPLETED';
    currentStep: string;
  };
  activeSessionBound: true;
  effectiveTenantPermissions: string[];
}


