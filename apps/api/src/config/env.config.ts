import * as path from 'node:path';
import * as dotenv from 'dotenv';

// Load workspace root .env first, then local apps/api/.env overrides if present
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface AppEnvConfig {
  nodeEnv: string;
  apiHost: string;
  apiPort: number;
  corsAllowedOrigins: string[];
  swaggerEnabled: boolean;
  database: {
    appUrl: string;
    migratorUrl: string;
    poolMin: number;
    poolMax: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
    statementTimeoutMs: number;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    cacheDb: number;
    queueDb: number;
  };
  brandingDefaults: {
    productName: string;
    tagline: string;
    supportEmail: string;
    websiteUrl: string;
    primaryColorHex: string;
    accentColorHex: string;
  };
  auth: {
    jwtSecret: string;
    jwtIssuer: string;
    jwtAudience: string;
    accessTokenTtlSeconds: number;
    refreshIdleTtlSeconds: number;
    sessionAbsoluteTtlSeconds: number;
    emailVerificationTtlSeconds: number;
    passwordResetTtlSeconds: number;
    cookieSecure: boolean;
    cookieDomain?: string;
    argon2MemoryCostKiB: number;
    argon2TimeCost: number;
    argon2Parallelism: number;
    rateLimitWindowSeconds: number;
    rateLimitMaxLoginFailures: number;
    rateLimitLockoutSeconds: number;
    rateLimitIpBurstMax: number;
    devOutboxEnabled: boolean;
    bootstrapSuperAdminEmail?: string;
    bootstrapSuperAdminPassword?: string;
    bootstrapSuperAdminFullName?: string;
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid environment variable ${name}: expected non-negative integer, got "${raw}".`);
  }
  return parsed;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppEnvConfig {
  const appUrl = env.DATABASE_APP_URL?.trim();
  const migratorUrl = env.DATABASE_MIGRATOR_URL?.trim();

  if (!appUrl) {
    throw new Error('Missing required environment variable: DATABASE_APP_URL');
  }
  if (!migratorUrl) {
    throw new Error('Missing required environment variable: DATABASE_MIGRATOR_URL');
  }
  if (appUrl === migratorUrl) {
    throw new Error(
      'Security violation: DATABASE_APP_URL and DATABASE_MIGRATOR_URL must use distinct PostgreSQL roles so runtime queries never own protected tables.',
    );
  }

  const primaryColorHex = env.DEFAULT_PRIMARY_COLOR_HEX?.trim() || '#2563EB';
  const accentColorHex = env.DEFAULT_ACCENT_COLOR_HEX?.trim() || '#0F172A';
  if (!/^#[0-9A-Fa-f]{6}$/.test(primaryColorHex) || !/^#[0-9A-Fa-f]{6}$/.test(accentColorHex)) {
    throw new Error('Invalid DEFAULT_PRIMARY_COLOR_HEX or DEFAULT_ACCENT_COLOR_HEX: expected #RRGGBB hex string.');
  }

  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const rawJwtSecret = env.AUTH_JWT_SECRET?.trim();
  if (nodeEnv === 'production' && (!rawJwtSecret || rawJwtSecret.length < 32)) {
    throw new Error(
      'Security violation: AUTH_JWT_SECRET is required in production and must be at least 32 characters long.',
    );
  }
  const jwtSecret =
    rawJwtSecret && rawJwtSecret.length >= 32
      ? rawJwtSecret
      : 'ft360-non-prod-dev-jwt-signing-secret-key-min-32-bytes';
  if (rawJwtSecret && rawJwtSecret.length < 32) {
    throw new Error('Invalid AUTH_JWT_SECRET: must be at least 32 characters long.');
  }

  const cookieSecureRaw = env.COOKIE_SECURE?.trim().toLowerCase();
  const cookieSecure =
    cookieSecureRaw !== undefined ? cookieSecureRaw === 'true' : nodeEnv === 'production';

  const devOutboxEnabled =
    nodeEnv !== 'production' &&
    (env.AUTH_DEV_OUTBOX_ENABLED ?? 'true').trim().toLowerCase() === 'true';

  return {
    nodeEnv,
    apiHost: env.API_HOST?.trim() || '0.0.0.0',
    apiPort: parsePositiveInt(env.API_PORT, 4000, 'API_PORT'),
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    swaggerEnabled: (env.SWAGGER_ENABLED ?? 'true').toLowerCase() === 'true',
    database: {
      appUrl,
      migratorUrl,
      poolMin: parsePositiveInt(env.DB_POOL_MIN, 2, 'DB_POOL_MIN'),
      poolMax: parsePositiveInt(env.DB_POOL_MAX, 20, 'DB_POOL_MAX'),
      idleTimeoutMs: parsePositiveInt(env.DB_IDLE_TIMEOUT_MS, 30000, 'DB_IDLE_TIMEOUT_MS'),
      connectionTimeoutMs: parsePositiveInt(env.DB_CONNECTION_TIMEOUT_MS, 5000, 'DB_CONNECTION_TIMEOUT_MS'),
      statementTimeoutMs: parsePositiveInt(env.DB_STATEMENT_TIMEOUT_MS, 15000, 'DB_STATEMENT_TIMEOUT_MS'),
    },
    redis: {
      host: env.REDIS_HOST?.trim() || 'localhost',
      port: parsePositiveInt(env.REDIS_PORT, 6379, 'REDIS_PORT'),
      password: env.REDIS_PASSWORD?.trim() || undefined,
      cacheDb: parsePositiveInt(env.REDIS_DB_CACHE, 0, 'REDIS_DB_CACHE'),
      queueDb: parsePositiveInt(env.REDIS_DB_QUEUE, 1, 'REDIS_DB_QUEUE'),
    },
    brandingDefaults: {
      productName: env.DEFAULT_PRODUCT_NAME?.trim() || 'FunnelTrack360',
      tagline: env.DEFAULT_PRODUCT_TAGLINE?.trim() || 'Enterprise Multi-Tenant CRM & Operations Suite',
      supportEmail: env.DEFAULT_SUPPORT_EMAIL?.trim() || 'support@example.local',
      websiteUrl: env.DEFAULT_WEBSITE_URL?.trim() || 'http://localhost:3000',
      primaryColorHex,
      accentColorHex,
    },
    auth: {
      jwtSecret,
      jwtIssuer: env.AUTH_JWT_ISSUER?.trim() || 'ft360-auth',
      jwtAudience: env.AUTH_JWT_AUDIENCE?.trim() || 'ft360-web-api',
      accessTokenTtlSeconds: Math.max(60, parsePositiveInt(env.AUTH_ACCESS_TOKEN_TTL_SECONDS, 900, 'AUTH_ACCESS_TOKEN_TTL_SECONDS')),
      refreshIdleTtlSeconds: Math.max(300, parsePositiveInt(env.AUTH_REFRESH_IDLE_TTL_SECONDS, 604800, 'AUTH_REFRESH_IDLE_TTL_SECONDS')),
      sessionAbsoluteTtlSeconds: Math.max(600, parsePositiveInt(env.AUTH_SESSION_ABSOLUTE_TTL_SECONDS, 2592000, 'AUTH_SESSION_ABSOLUTE_TTL_SECONDS')),
      emailVerificationTtlSeconds: Math.max(300, parsePositiveInt(env.AUTH_EMAIL_VERIFY_TTL_SECONDS, 86400, 'AUTH_EMAIL_VERIFY_TTL_SECONDS')),
      passwordResetTtlSeconds: Math.max(300, parsePositiveInt(env.AUTH_PASSWORD_RESET_TTL_SECONDS, 1800, 'AUTH_PASSWORD_RESET_TTL_SECONDS')),
      cookieSecure,
      cookieDomain: env.COOKIE_DOMAIN?.trim() || undefined,
      argon2MemoryCostKiB: Math.max(16384, parsePositiveInt(env.AUTH_ARGON2_MEMORY_COST_KIB, 65536, 'AUTH_ARGON2_MEMORY_COST_KIB')),
      argon2TimeCost: Math.max(2, parsePositiveInt(env.AUTH_ARGON2_TIME_COST, 3, 'AUTH_ARGON2_TIME_COST')),
      argon2Parallelism: Math.max(1, parsePositiveInt(env.AUTH_ARGON2_PARALLELISM, 4, 'AUTH_ARGON2_PARALLELISM')),
      rateLimitWindowSeconds: Math.max(30, parsePositiveInt(env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 900, 'AUTH_RATE_LIMIT_WINDOW_SECONDS')),
      rateLimitMaxLoginFailures: Math.max(2, parsePositiveInt(env.AUTH_RATE_LIMIT_MAX_FAILURES, 5, 'AUTH_RATE_LIMIT_MAX_FAILURES')),
      rateLimitLockoutSeconds: Math.max(30, parsePositiveInt(env.AUTH_RATE_LIMIT_LOCKOUT_SECONDS, 900, 'AUTH_RATE_LIMIT_LOCKOUT_SECONDS')),
      rateLimitIpBurstMax: Math.max(5, parsePositiveInt(env.AUTH_RATE_LIMIT_IP_BURST_MAX, 30, 'AUTH_RATE_LIMIT_IP_BURST_MAX')),
      devOutboxEnabled,
      bootstrapSuperAdminEmail: env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim() || undefined,
      bootstrapSuperAdminPassword: env.BOOTSTRAP_SUPER_ADMIN_PASSWORD || undefined,
      bootstrapSuperAdminFullName: env.BOOTSTRAP_SUPER_ADMIN_FULL_NAME?.trim() || undefined,
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

