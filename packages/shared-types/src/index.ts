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

