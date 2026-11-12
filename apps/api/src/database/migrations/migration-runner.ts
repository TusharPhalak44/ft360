import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool, type PoolClient } from 'pg';

export interface MigrationRecord {
  version: string;
  name: string;
  checksum_sha256: string;
  applied_by: string;
  execution_ms: number;
  applied_at: Date;
}

export interface DiscoveredMigration {
  version: string;
  name: string;
  upPath: string;
  downPath: string;
  checksumSha256: string;
}

const MIGRATION_ADVISORY_LOCK_KEY = 360001;

export class SqlMigrationRunner {
  private readonly pool: Pool;
  private readonly migrationsDir: string;

  constructor(migratorDatabaseUrl: string, migrationsDir?: string) {
    this.pool = new Pool({
      connectionString: migratorDatabaseUrl,
      max: 2,
      application_name: 'ft360-migrator',
    });
    this.migrationsDir = migrationsDir ?? SqlMigrationRunner.resolveDefaultMigrationsDir();
  }

  static resolveDefaultMigrationsDir(): string {
    const candidates = [
      path.resolve(process.cwd(), 'db/migrations'),
      path.resolve(process.cwd(), '../../db/migrations'),
      path.resolve(__dirname, '../../../../../db/migrations'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Unable to locate db/migrations directory. Checked: ${candidates.join(', ')}`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  discoverMigrations(): DiscoveredMigration[] {
    if (!fs.existsSync(this.migrationsDir)) {
      throw new Error(`Migrations directory does not exist: ${this.migrationsDir}`);
    }

    const entries = fs
      .readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.up.sql'))
      .sort();

    return entries.map((upFile) => {
      const base = upFile.slice(0, -'.up.sql'.length);
      const match = /^(\d{4})_([a-z0-9_]+)$/.exec(base);
      if (!match) {
        throw new Error(
          `Invalid migration filename "${upFile}". Expected format: NNNN_snake_case_description.up.sql`,
        );
      }

      const upPath = path.join(this.migrationsDir, upFile);
      const downPath = path.join(this.migrationsDir, `${base}.down.sql`);
      if (!fs.existsSync(downPath)) {
        throw new Error(`Missing companion rollback migration file for "${upFile}": expected "${base}.down.sql"`);
      }

      const upContentNormalized = fs.readFileSync(upPath, 'utf8').replace(/\r\n/g, '\n');
      const checksumSha256 = crypto.createHash('sha256').update(upContentNormalized, 'utf8').digest('hex');

      return {
        version: match[1],
        name: base,
        upPath,
        downPath,
        checksumSha256,
      };
    });
  }

  async migrateUp(): Promise<string[]> {
    return this.withAdvisoryLock(async (client) => {
      await this.ensureLedgerTable(client);
      const appliedMap = await this.loadAppliedMigrations(client);
      const discovered = this.discoverMigrations();

      // Verify immutable checksums on all previously applied migrations
      for (const item of discovered) {
        const existing = appliedMap.get(item.version);
        if (existing && existing.checksum_sha256 !== item.checksumSha256) {
          throw new Error(
            `Migration checksum mismatch for ${item.name}! Applied=${existing.checksum_sha256}, Disk=${item.checksumSha256}. Applied migrations are immutable.`,
          );
        }
      }

      const executed: string[] = [];
      for (const item of discovered) {
        if (appliedMap.has(item.version)) {
          continue;
        }

        const sql = fs.readFileSync(item.upPath, 'utf8');
        const start = performance.now();

        await client.query('BEGIN');
        try {
          await client.query(sql);
          const executionMs = Math.max(1, Math.round(performance.now() - start));
          await client.query(
            `INSERT INTO public.schema_migrations (version, name, checksum_sha256, applied_by, execution_ms)
             VALUES ($1, $2, $3, current_user, $4)`,
            [item.version, item.name, item.checksumSha256, executionMs],
          );
          await client.query('COMMIT');
          executed.push(item.name);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }

      return executed;
    });
  }

  async rollbackLatest(): Promise<string | null> {
    return this.withAdvisoryLock(async (client) => {
      await this.ensureLedgerTable(client);
      const latestRes = await client.query<MigrationRecord>(
        `SELECT version, name, checksum_sha256, applied_by, execution_ms, applied_at
         FROM public.schema_migrations
         ORDER BY version DESC
         LIMIT 1`,
      );

      const latest = latestRes.rows[0];
      if (!latest) {
        return null;
      }

      const discovered = this.discoverMigrations().find((m) => m.version === latest.version);
      if (!discovered) {
        throw new Error(`Cannot roll back migration ${latest.name}: .down.sql file not found on disk.`);
      }

      const downSql = fs.readFileSync(discovered.downPath, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(downSql);
        await client.query(`DELETE FROM public.schema_migrations WHERE version = $1`, [latest.version]);
        await client.query('COMMIT');
        return latest.name;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  async getStatus(): Promise<
    Array<{ version: string; name: string; status: 'APPLIED' | 'PENDING'; appliedAt: string | null }>
  > {
    return this.withAdvisoryLock(async (client) => {
      await this.ensureLedgerTable(client);
      const appliedMap = await this.loadAppliedMigrations(client);
      const discovered = this.discoverMigrations();

      return discovered.map((m) => {
        const rec = appliedMap.get(m.version);
        return {
          version: m.version,
          name: m.name,
          status: rec ? 'APPLIED' : 'PENDING',
          appliedAt: rec ? rec.applied_at.toISOString() : null,
        };
      });
    });
  }

  private async ensureLedgerTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version VARCHAR(16) PRIMARY KEY,
        name VARCHAR(180) NOT NULL UNIQUE,
        checksum_sha256 CHAR(64) NOT NULL,
        applied_by VARCHAR(128) NOT NULL,
        execution_ms INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      GRANT SELECT ON public.schema_migrations TO ft360_app;
    `);
  }

  private async loadAppliedMigrations(client: PoolClient): Promise<Map<string, MigrationRecord>> {
    const res = await client.query<MigrationRecord>(
      `SELECT version, name, checksum_sha256, applied_by, execution_ms, applied_at
       FROM public.schema_migrations
       ORDER BY version ASC`,
    );
    return new Map(res.rows.map((r) => [r.version, r]));
  }

  private async withAdvisoryLock<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      try {
        return await fn(client);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}

