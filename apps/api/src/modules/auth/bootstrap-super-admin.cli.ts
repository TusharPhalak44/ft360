import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import { BootstrapSuperAdminService } from './bootstrap-super-admin.service';

async function runBootstrapSuperAdminCli(): Promise<void> {
  const appContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const config = appContext.get<AppEnvConfig>(APP_CONFIG);
    const email = config.auth.bootstrapSuperAdminEmail;
    const password = config.auth.bootstrapSuperAdminPassword;
    const fullName =
      config.auth.bootstrapSuperAdminFullName || 'Platform Super Administrator';

    if (!email || !password) {
      throw new Error(
        'Missing BOOTSTRAP_SUPER_ADMIN_EMAIL or BOOTSTRAP_SUPER_ADMIN_PASSWORD for one-time initial Super Admin bootstrap.',
      );
    }

    const bootstrapService = appContext.get(BootstrapSuperAdminService);
    const result = await bootstrapService.provisionInitialSuperAdmin({
      email,
      password,
      fullName,
    });

    console.log(
      `[auth:bootstrap-super-admin] Initial Platform Super Admin provisioned (userId=${result.userId}). Remove BOOTSTRAP_SUPER_ADMIN_* secrets now.`,
    );
  } finally {
    await appContext.close();
  }
}

runBootstrapSuperAdminCli().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[auth:bootstrap-super-admin] Failed: ${message}`);
  process.exit(1);
});
