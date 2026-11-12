import { loadAppConfig } from '../../config/env.config';
import { SqlMigrationRunner } from './migration-runner';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  const config = loadAppConfig();
  const runner = new SqlMigrationRunner(config.database.migratorUrl);

  try {
    if (command === 'up') {
      const applied = await runner.migrateUp();
      if (applied.length === 0) {
        console.log('[db:migrate] Schema is already up to date (0 pending migrations).');
      } else {
        console.log(`[db:migrate] Successfully applied ${applied.length} migration(s):`);
        for (const name of applied) {
          console.log(`  + ${name}`);
        }
      }
    } else if (command === 'down') {
      const rolledBack = await runner.rollbackLatest();
      if (!rolledBack) {
        console.log('[db:migrate:rollback] No applied migrations to roll back.');
      } else {
        console.log(`[db:migrate:rollback] Rolled back latest migration: ${rolledBack}`);
      }
    } else if (command === 'status') {
      const rows = await runner.getStatus();
      console.table(rows);
    } else {
      console.error(`Unknown migration command "${command}". Expected: up | down | status`);
      process.exitCode = 1;
    }
  } finally {
    await runner.close();
  }
}

main().catch((err: unknown) => {
  console.error('[db:migrate] Migration command failed:', err);
  process.exit(1);
});

