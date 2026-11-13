import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { PlatformDirectoryRepository } from '../foundation-db/platform-directory.repository';
import { PasswordHashService } from './password-hash.service';

@Injectable()
export class BootstrapSuperAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapSuperAdminService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
    private readonly txManager: TenantTransactionManager,
    private readonly platformRepo: PlatformDirectoryRepository,
    private readonly passwordHashService: PasswordHashService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = this.config.auth.bootstrapSuperAdminEmail;
    const password = this.config.auth.bootstrapSuperAdminPassword;
    if (!email || !password) {
      return;
    }

    await this.ensureSuperAdminProvisioned({
      email,
      password,
      fullName: this.config.auth.bootstrapSuperAdminFullName || 'Platform Super Administrator',
    });
  }

  async ensureSuperAdminProvisioned(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<{ userId: string; created: boolean }> {
    const normalizedEmail = input.email.trim().toLowerCase();
    this.passwordHashService.validatePasswordPolicy(input.password, normalizedEmail);
    const passwordHash = await this.passwordHashService.hashPassword(input.password);

    return this.txManager.withSystemBootstrapTransaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM public.users WHERE email = $1::citext`,
        [normalizedEmail],
      );

      if (existing.rows[0]) {
        const userId = existing.rows[0].id;
        await tx.query(
          `UPDATE public.users
              SET password_hash = $2,
                  status = 'ACTIVE',
                  is_platform_super_admin = TRUE,
                  email_verified = TRUE
            WHERE id = $1::uuid`,
          [userId, passwordHash],
        );
        this.logger.log(`Verified bootstrap Platform Super Admin (${normalizedEmail}).`);
        return { userId, created: false };
      }

      const created = await this.platformRepo.createUser(tx, {
        email: normalizedEmail,
        passwordHash,
        fullName: input.fullName,
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        emailVerified: true,
      });
      this.logger.log(`Provisioned bootstrap Platform Super Admin (${normalizedEmail}).`);
      return { userId: created.id, created: true };
    });
  }
}
