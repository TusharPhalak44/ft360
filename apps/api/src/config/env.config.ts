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

  return {
    nodeEnv: env.NODE_ENV?.trim() || 'development',
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
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

