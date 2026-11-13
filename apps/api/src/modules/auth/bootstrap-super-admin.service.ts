import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG, type AppEnvConfig } from '../../config/env.config';
import { TenantTransactionManager } from '../../database/tenant-transaction.manager';
import { AuthAuditService } from './auth-audit.service';
import { PasswordHashService } from './password-hash.service';

export type InitialSuperAdminBootstrapOutcome =
  | 'CREATED'
  | 'SUPER_ADMIN_ALREADY_EXISTS'
  | 'EMAIL_CONFLICT_EXISTING_USER';

export interface InitialSuperAdminBootstrapResult {
  outcome: 'CREATED';
  userId: string;
}

/**
 * Controlled one-time Platform Super Admin provisioning service.
 *
 * Security invariants:
 * 1. Normal NestJS application startup (`onApplicationBootstrap`) NEVER creates, elevates,
 *    activates, marks email-verified, or overwrites the password of any user — even if
 *    `BOOTSTRAP_SUPER_ADMIN_*` environment variables accidentally remain configured.
 * 2. Initial Super Admin provisioning (`provisionInitialSuperAdmin`) must be invoked
 *    explicitly (e.g. via the controlled one-time CLI `npm run auth:bootstrap-super-admin`).
 * 3. Inside PostgreSQL (`fn_auth_bootstrap_initial_super_admin` under advisory lock `360003`),
 *    provisioning is refused with `409 ConflictException` if:
 *      - ANY `ACTIVE` Platform Super Admin already exists (`SUPER_ADMIN_ALREADY_EXISTS`), OR
 *      - `email` matches ANY existing user account (`EMAIL_CONFLICT_EXISTING_USER`).
 */
@Injectable()
export class BootstrapSuperAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapSuperAdminService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppEnvConfig,
    private readonly txManager: TenantTransactionManager,
    private readonly passwordHashService: PasswordHashService,
    private readonly auditService: AuthAuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (
      this.config.auth.bootstrapSuperAdminEmail ||
      this.config.auth.bootstrapSuperAdminPassword
    ) {
      this.logger.warn(
        'BOOTSTRAP_SUPER_ADMIN_* environment variables detected during normal application startup. ' +
          'Automatic startup account elevation/password mutation is disabled by security policy; no database accounts were modified. ' +
          'Use the controlled one-time CLI ("npm run auth:bootstrap-super-admin") if initial provisioning is required, then remove BOOTSTRAP_SUPER_ADMIN_* from the environment.',
      );
    }
  }

  async provisionInitialSuperAdmin(input: {
    email: string;
    password: string;
    fullName: string;
    correlationId?: string;
  }): Promise<InitialSuperAdminBootstrapResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const trimmedFullName = input.fullName.trim() || 'Platform Super Administrator';
    const correlationId = input.correlationId ?? randomUUID();

    this.passwordHashService.validatePasswordPolicy(input.password, normalizedEmail);
    const passwordHash = await this.passwordHashService.hashPassword(input.password);

    const txResult = await this.txManager.withSystemBootstrapTransaction(async (tx) => {
      const res = await tx.query<{
        outcome: InitialSuperAdminBootstrapOutcome;
        user_id: string;
      }>(
        `SELECT outcome, user_id
         FROM public.fn_auth_bootstrap_initial_super_admin($1::citext, $2, $3)`,
        [normalizedEmail, passwordHash, trimmedFullName],
      );

      const row = res.rows[0];
      if (!row || row.outcome === 'SUPER_ADMIN_ALREADY_EXISTS') {
        await this.auditService.record({
          eventType: 'AUTH_SUPER_ADMIN_BOOTSTRAP_REFUSED',
          outcome: 'DENIED',
          correlationId,
          targetUserId: row?.user_id ?? null,
          metadata: {
            attemptedEmail: normalizedEmail,
            reason: 'SUPER_ADMIN_ALREADY_EXISTS',
          },
          tx,
        });
        return { outcome: 'SUPER_ADMIN_ALREADY_EXISTS' as const, userId: row?.user_id ?? null };
      }

      if (row.outcome === 'EMAIL_CONFLICT_EXISTING_USER') {
        await this.auditService.record({
          eventType: 'AUTH_SUPER_ADMIN_BOOTSTRAP_REFUSED',
          outcome: 'DENIED',
          correlationId,
          targetUserId: row.user_id,
          metadata: {
            attemptedEmail: normalizedEmail,
            reason: 'EMAIL_CONFLICT_EXISTING_USER',
          },
          tx,
        });
        return { outcome: 'EMAIL_CONFLICT_EXISTING_USER' as const, userId: row.user_id };
      }

      await this.auditService.record({
        eventType: 'AUTH_SUPER_ADMIN_BOOTSTRAPPED',
        outcome: 'SUCCESS',
        correlationId,
        targetUserId: row.user_id,
        metadata: {
          email: normalizedEmail,
        },
        tx,
      });

      this.logger.log(
        `Provisioned initial Platform Super Admin (${normalizedEmail}). Remove BOOTSTRAP_SUPER_ADMIN_* secrets from environment immediately.`,
      );

      return {
        outcome: 'CREATED' as const,
        userId: row.user_id,
      };
    });

    if (txResult.outcome === 'SUPER_ADMIN_ALREADY_EXISTS') {
      throw new ConflictException({
        code: 'SUPER_ADMIN_ALREADY_PROVISIONED',
        message:
          'Initial Platform Super Admin bootstrap refused: an active Platform Super Admin already exists.',
      });
    }

    if (txResult.outcome === 'EMAIL_CONFLICT_EXISTING_USER') {
      throw new ConflictException({
        code: 'BOOTSTRAP_EMAIL_CONFLICT',
        message:
          'Initial Platform Super Admin bootstrap refused: email address already belongs to an existing user account and will never be silently promoted or overwritten.',
      });
    }

    return {
      outcome: 'CREATED',
      userId: txResult.userId,
    };
  }
}
