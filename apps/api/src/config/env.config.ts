import * as path from 'node:path';
import * as dotenv from 'dotenv';

// Load workspace root .env first, then local apps/api/.env overrides if present
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export type AuthMailProviderKind = 'disabled' | 'smtp' | 'webhook' | 'sandbox';

export interface AuthMailConfig {
  provider: AuthMailProviderKind;
  fromEmail: string;
  fromName: string;
  outboxEncryptionSecret: string;
  maxAttempts: number;
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
  pollIntervalMs: number;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    requireTls: boolean;
    user?: string;
    password?: string;
    timeoutMs: number;
  };
  webhook: {
    url?: string;
    bearerToken?: string;
    timeoutMs: number;
  };
}

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
    mail: AuthMailConfig;
    bootstrapSuperAdminEmail?: string;
    bootstrapSuperAdminPassword?: string;
    bootstrapSuperAdminFullName?: string;
  };
}

const PERMITTED_DEV_OUTBOX_ENVS = new Set(['development', 'test']);

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Invalid environment variable ${name}: expected non-negative integer, got "${raw}".`,
    );
  }
  return parsed;
}

function parseStrictBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(
    `Invalid environment variable ${name}: expected "true" or "false", got "${raw}".`,
  );
}

export function validateCookieDomain(rawDomain: string | undefined): string | undefined {
  if (rawDomain === undefined || rawDomain.trim() === '') {
    return undefined;
  }

  const trimmed = rawDomain.trim();
  const hasControlChar = Array.from(trimmed).some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (/[\s;:/\\?#@]/.test(trimmed) || hasControlChar) {
    throw new Error(
      `Invalid COOKIE_DOMAIN "${rawDomain}": must be a bare domain name without scheme, port, path, or control characters.`,
    );
  }

  const withoutLeadingDot = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
  if (
    withoutLeadingDot === '' ||
    withoutLeadingDot.endsWith('.') ||
    withoutLeadingDot.includes('..') ||
    withoutLeadingDot.length > 253
  ) {
    throw new Error(`Invalid COOKIE_DOMAIN "${rawDomain}": malformed domain syntax.`);
  }

  const lower = withoutLeadingDot.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    throw new Error(
      `Invalid COOKIE_DOMAIN "${rawDomain}": omit COOKIE_DOMAIN for host-only localhost cookies.`,
    );
  }

  // Reject IPv4 literals (cookies scoped to raw IP literals should omit Domain)
  if (/^\d+(?:\.\d+){3}$/.test(lower)) {
    throw new Error(
      `Invalid COOKIE_DOMAIN "${rawDomain}": IP literals are not valid Cookie Domain attributes.`,
    );
  }

  const labels = lower.split('.');
  if (labels.length < 2) {
    throw new Error(
      `Invalid COOKIE_DOMAIN "${rawDomain}": single-label or public-suffix TLD domains are forbidden.`,
    );
  }

  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const label of labels) {
    if (!labelPattern.test(label)) {
      throw new Error(
        `Invalid COOKIE_DOMAIN "${rawDomain}": domain label "${label}" violates RFC 1035/6265.`,
      );
    }
  }
  // Final TLD label cannot be all-numeric
  if (/^\d+$/.test(labels[labels.length - 1])) {
    throw new Error(`Invalid COOKIE_DOMAIN "${rawDomain}": top-level label cannot be numeric.`);
  }

  return trimmed.startsWith('.') ? `.${lower}` : lower;
}

function parseMailProvider(raw: string | undefined, nodeEnv: string): AuthMailProviderKind {
  const normalized = (raw?.trim().toLowerCase() || 'disabled') as AuthMailProviderKind;
  if (!['disabled', 'smtp', 'webhook', 'sandbox'].includes(normalized)) {
    throw new Error(
      `Invalid AUTH_MAIL_PROVIDER "${raw}": expected one of disabled, smtp, webhook, sandbox.`,
    );
  }

  if (normalized === 'sandbox' && !PERMITTED_DEV_OUTBOX_ENVS.has(nodeEnv)) {
    throw new Error(
      `Security violation: AUTH_MAIL_PROVIDER="sandbox" is forbidden in NODE_ENV="${nodeEnv}". Configure "smtp" or "webhook" for non-local environments.`,
    );
  }

  return normalized;
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
    throw new Error(
      'Invalid DEFAULT_PRIMARY_COLOR_HEX or DEFAULT_ACCENT_COLOR_HEX: expected #RRGGBB hex string.',
    );
  }

  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const rawJwtSecret = env.AUTH_JWT_SECRET?.trim();
  if (nodeEnv === 'production' && (!rawJwtSecret || rawJwtSecret.length < 32)) {
    throw new Error(
      'Security violation: AUTH_JWT_SECRET is required in production and must be at least 32 characters long.',
    );
  }
  if (rawJwtSecret && rawJwtSecret.length < 32) {
    throw new Error('Invalid AUTH_JWT_SECRET: must be at least 32 characters long.');
  }
  const jwtSecret =
    rawJwtSecret && rawJwtSecret.length >= 32
      ? rawJwtSecret
      : 'ft360-non-prod-dev-jwt-signing-secret-key-min-32-bytes';

  // Production cookie hardening: Secure is mandatory in production; COOKIE_SECURE=false is rejected
  const cookieSecure = parseStrictBoolean(
    env.COOKIE_SECURE,
    nodeEnv === 'production',
    'COOKIE_SECURE',
  );
  if (nodeEnv === 'production' && !cookieSecure) {
    throw new Error(
      'Security violation: COOKIE_SECURE=false is forbidden in production. Secure cookies are mandatory in production.',
    );
  }

  const cookieDomain = validateCookieDomain(env.COOKIE_DOMAIN);

  // Development outbox defaults to disabled (false) and is strictly forbidden outside development/test
  const requestedDevOutbox = parseStrictBoolean(
    env.AUTH_DEV_OUTBOX_ENABLED,
    false,
    'AUTH_DEV_OUTBOX_ENABLED',
  );
  if (requestedDevOutbox && !PERMITTED_DEV_OUTBOX_ENVS.has(nodeEnv)) {
    throw new Error(
      `Security violation: AUTH_DEV_OUTBOX_ENABLED=true is forbidden in NODE_ENV="${nodeEnv}". Development token preview is permitted strictly in "development" and "test".`,
    );
  }
  const devOutboxEnabled = requestedDevOutbox && PERMITTED_DEV_OUTBOX_ENVS.has(nodeEnv);

  // Transactional email provider & durable outbox settings
  const productName = env.DEFAULT_PRODUCT_NAME?.trim() || 'FunnelTrack360';
  const supportEmail = env.DEFAULT_SUPPORT_EMAIL?.trim() || 'support@example.local';
  const mailProvider = parseMailProvider(env.AUTH_MAIL_PROVIDER, nodeEnv);
  const mailFromEmail = env.AUTH_MAIL_FROM_EMAIL?.trim() || supportEmail;
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(mailFromEmail)) {
    throw new Error(`Invalid AUTH_MAIL_FROM_EMAIL "${mailFromEmail}": expected valid email address.`);
  }
  const mailFromName = env.AUTH_MAIL_FROM_NAME?.trim() || productName;

  const rawOutboxSecret = env.AUTH_OUTBOX_ENCRYPTION_SECRET?.trim();
  if (rawOutboxSecret !== undefined && rawOutboxSecret !== '' && rawOutboxSecret.length < 32) {
    throw new Error(
      'Invalid AUTH_OUTBOX_ENCRYPTION_SECRET: must be at least 32 characters long when specified.',
    );
  }
  const outboxEncryptionSecret =
    rawOutboxSecret && rawOutboxSecret.length >= 32 ? rawOutboxSecret : jwtSecret;

  const smtpHost = env.AUTH_SMTP_HOST?.trim() || '';
  const smtpPort = parsePositiveInt(env.AUTH_SMTP_PORT, 587, 'AUTH_SMTP_PORT');
  if (mailProvider === 'smtp') {
    if (!smtpHost) {
      throw new Error('Missing required AUTH_SMTP_HOST when AUTH_MAIL_PROVIDER="smtp".');
    }
    if (smtpPort < 1 || smtpPort > 65535) {
      throw new Error(`Invalid AUTH_SMTP_PORT "${smtpPort}": expected TCP port 1..65535.`);
    }
  }

  const webhookUrl = env.AUTH_MAIL_WEBHOOK_URL?.trim() || undefined;
  if (mailProvider === 'webhook') {
    if (!webhookUrl) {
      throw new Error(
        'Missing required AUTH_MAIL_WEBHOOK_URL when AUTH_MAIL_PROVIDER="webhook".',
      );
    }
    let parsedWebhook: URL;
    try {
      parsedWebhook = new URL(webhookUrl);
    } catch {
      throw new Error(`Invalid AUTH_MAIL_WEBHOOK_URL "${webhookUrl}": expected valid URL.`);
    }
    if (parsedWebhook.protocol !== 'https:' && parsedWebhook.protocol !== 'http:') {
      throw new Error('Invalid AUTH_MAIL_WEBHOOK_URL: protocol must be https: or http:.');
    }
    if (nodeEnv === 'production' && parsedWebhook.protocol !== 'https:') {
      throw new Error(
        'Security violation: AUTH_MAIL_WEBHOOK_URL must use https:// in production.',
      );
    }
  }

  const baseBackoffSeconds = Math.min(
    300,
    Math.max(1, parsePositiveInt(env.AUTH_MAIL_BASE_BACKOFF_SECONDS, 5, 'AUTH_MAIL_BASE_BACKOFF_SECONDS')),
  );
  const maxBackoffSeconds = Math.max(
    baseBackoffSeconds,
    parsePositiveInt(env.AUTH_MAIL_MAX_BACKOFF_SECONDS, 300, 'AUTH_MAIL_MAX_BACKOFF_SECONDS'),
  );
  const defaultPollMs = nodeEnv === 'test' ? 0 : 15000;

  return {
    nodeEnv,
    apiHost: env.API_HOST?.trim() || '0.0.0.0',
    apiPort: parsePositiveInt(env.API_PORT, 4000, 'API_PORT'),
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    swaggerEnabled: parseStrictBoolean(env.SWAGGER_ENABLED, true, 'SWAGGER_ENABLED'),
    database: {
      appUrl,
      migratorUrl,
      poolMin: parsePositiveInt(env.DB_POOL_MIN, 2, 'DB_POOL_MIN'),
      poolMax: parsePositiveInt(env.DB_POOL_MAX, 20, 'DB_POOL_MAX'),
      idleTimeoutMs: parsePositiveInt(env.DB_IDLE_TIMEOUT_MS, 30000, 'DB_IDLE_TIMEOUT_MS'),
      connectionTimeoutMs: parsePositiveInt(
        env.DB_CONNECTION_TIMEOUT_MS,
        5000,
        'DB_CONNECTION_TIMEOUT_MS',
      ),
      statementTimeoutMs: parsePositiveInt(
        env.DB_STATEMENT_TIMEOUT_MS,
        15000,
        'DB_STATEMENT_TIMEOUT_MS',
      ),
    },
    redis: {
      host: env.REDIS_HOST?.trim() || 'localhost',
      port: parsePositiveInt(env.REDIS_PORT, 6379, 'REDIS_PORT'),
      password: env.REDIS_PASSWORD?.trim() || undefined,
      cacheDb: parsePositiveInt(env.REDIS_DB_CACHE, 0, 'REDIS_DB_CACHE'),
      queueDb: parsePositiveInt(env.REDIS_DB_QUEUE, 1, 'REDIS_DB_QUEUE'),
    },
    brandingDefaults: {
      productName,
      tagline:
        env.DEFAULT_PRODUCT_TAGLINE?.trim() || 'Enterprise Multi-Tenant CRM & Operations Suite',
      supportEmail,
      websiteUrl: env.DEFAULT_WEBSITE_URL?.trim() || 'http://localhost:3000',
      primaryColorHex,
      accentColorHex,
    },
    auth: {
      jwtSecret,
      jwtIssuer: env.AUTH_JWT_ISSUER?.trim() || 'ft360-auth',
      jwtAudience: env.AUTH_JWT_AUDIENCE?.trim() || 'ft360-web-api',
      accessTokenTtlSeconds: Math.max(
        60,
        parsePositiveInt(env.AUTH_ACCESS_TOKEN_TTL_SECONDS, 900, 'AUTH_ACCESS_TOKEN_TTL_SECONDS'),
      ),
      refreshIdleTtlSeconds: Math.max(
        300,
        parsePositiveInt(
          env.AUTH_REFRESH_IDLE_TTL_SECONDS,
          604800,
          'AUTH_REFRESH_IDLE_TTL_SECONDS',
        ),
      ),
      sessionAbsoluteTtlSeconds: Math.max(
        600,
        parsePositiveInt(
          env.AUTH_SESSION_ABSOLUTE_TTL_SECONDS,
          2592000,
          'AUTH_SESSION_ABSOLUTE_TTL_SECONDS',
        ),
      ),
      emailVerificationTtlSeconds: Math.max(
        300,
        parsePositiveInt(env.AUTH_EMAIL_VERIFY_TTL_SECONDS, 86400, 'AUTH_EMAIL_VERIFY_TTL_SECONDS'),
      ),
      passwordResetTtlSeconds: Math.max(
        300,
        parsePositiveInt(
          env.AUTH_PASSWORD_RESET_TTL_SECONDS,
          1800,
          'AUTH_PASSWORD_RESET_TTL_SECONDS',
        ),
      ),
      cookieSecure,
      cookieDomain,
      argon2MemoryCostKiB: Math.max(
        16384,
        parsePositiveInt(env.AUTH_ARGON2_MEMORY_COST_KIB, 65536, 'AUTH_ARGON2_MEMORY_COST_KIB'),
      ),
      argon2TimeCost: Math.max(
        2,
        parsePositiveInt(env.AUTH_ARGON2_TIME_COST, 3, 'AUTH_ARGON2_TIME_COST'),
      ),
      argon2Parallelism: Math.max(
        1,
        parsePositiveInt(env.AUTH_ARGON2_PARALLELISM, 4, 'AUTH_ARGON2_PARALLELISM'),
      ),
      rateLimitWindowSeconds: Math.max(
        30,
        parsePositiveInt(
          env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
          900,
          'AUTH_RATE_LIMIT_WINDOW_SECONDS',
        ),
      ),
      rateLimitMaxLoginFailures: Math.max(
        2,
        parsePositiveInt(env.AUTH_RATE_LIMIT_MAX_FAILURES, 5, 'AUTH_RATE_LIMIT_MAX_FAILURES'),
      ),
      rateLimitLockoutSeconds: Math.max(
        30,
        parsePositiveInt(
          env.AUTH_RATE_LIMIT_LOCKOUT_SECONDS,
          900,
          'AUTH_RATE_LIMIT_LOCKOUT_SECONDS',
        ),
      ),
      rateLimitIpBurstMax: Math.max(
        5,
        parsePositiveInt(env.AUTH_RATE_LIMIT_IP_BURST_MAX, 30, 'AUTH_RATE_LIMIT_IP_BURST_MAX'),
      ),
      devOutboxEnabled,
      mail: {
        provider: mailProvider,
        fromEmail: mailFromEmail,
        fromName: mailFromName,
        outboxEncryptionSecret,
        maxAttempts: Math.min(
          10,
          Math.max(1, parsePositiveInt(env.AUTH_MAIL_MAX_ATTEMPTS, 5, 'AUTH_MAIL_MAX_ATTEMPTS')),
        ),
        baseBackoffSeconds,
        maxBackoffSeconds,
        pollIntervalMs: parsePositiveInt(
          env.AUTH_MAIL_OUTBOX_POLL_MS,
          defaultPollMs,
          'AUTH_MAIL_OUTBOX_POLL_MS',
        ),
        smtp: {
          host: smtpHost,
          port: smtpPort,
          secure: parseStrictBoolean(env.AUTH_SMTP_SECURE, smtpPort === 465, 'AUTH_SMTP_SECURE'),
          requireTls: parseStrictBoolean(env.AUTH_SMTP_REQUIRE_TLS, false, 'AUTH_SMTP_REQUIRE_TLS'),
          user: env.AUTH_SMTP_USER?.trim() || undefined,
          password: env.AUTH_SMTP_PASSWORD || undefined,
          timeoutMs: Math.max(
            1000,
            parsePositiveInt(env.AUTH_SMTP_TIMEOUT_MS, 10000, 'AUTH_SMTP_TIMEOUT_MS'),
          ),
        },
        webhook: {
          url: webhookUrl,
          bearerToken: env.AUTH_MAIL_WEBHOOK_BEARER_TOKEN?.trim() || undefined,
          timeoutMs: Math.max(
            1000,
            parsePositiveInt(
              env.AUTH_MAIL_WEBHOOK_TIMEOUT_MS,
              10000,
              'AUTH_MAIL_WEBHOOK_TIMEOUT_MS',
            ),
          ),
        },
      },
      bootstrapSuperAdminEmail: env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim() || undefined,
      bootstrapSuperAdminPassword: env.BOOTSTRAP_SUPER_ADMIN_PASSWORD || undefined,
      bootstrapSuperAdminFullName: env.BOOTSTRAP_SUPER_ADMIN_FULL_NAME?.trim() || undefined,
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
