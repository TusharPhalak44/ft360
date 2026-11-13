import { Injectable } from '@nestjs/common';
import type {
  PermissionEntity,
  PermissionScopePlane,
  TenantEntity,
  TenantStatus,
  UserEntity,
  UserStatus,
} from '@ft360/shared-types';
import type { QueryExecutor } from '../../database/database.types';

export interface CreateUserInput {
  email: string;
  fullName: string;
  passwordHash?: string | null;
  phoneE164?: string | null;
  status?: UserStatus;
  isPlatformSuperAdmin?: boolean;
  emailVerified?: boolean;
}

export interface CreateTenantInput {
  slug: string;
  legalName: string;
  displayName: string;
  status?: TenantStatus;
  defaultTimezone?: string;
  defaultCurrency?: string;
}

export interface CreatePermissionInput {
  code: string;
  scopePlane: PermissionScopePlane;
  moduleCode: string;
  description: string;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  phone_e164: string | null;
  status: UserStatus;
  is_platform_super_admin: boolean;
  email_verified: boolean;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TenantRow {
  id: string;
  slug: string;
  legal_name: string;
  display_name: string;
  status: TenantStatus;
  default_timezone: string;
  default_currency: string;
  activated_at: Date | string | null;
  suspended_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PermissionRow {
  id: string;
  code: string;
  scope_plane: PermissionScopePlane;
  module_code: string;
  description: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : String(val);
}

function toNullableIso(val: Date | string | null): string | null {
  if (val === null || val === undefined) return null;
  return toIso(val);
}

@Injectable()
export class PlatformDirectoryRepository {
  async createUser(tx: QueryExecutor, input: CreateUserInput): Promise<UserEntity> {
    const res = await tx.query<UserRow>(
      `INSERT INTO public.users (
         email,
         password_hash,
         full_name,
         phone_e164,
         status,
         is_platform_super_admin,
         email_verified
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING
         id, email::text AS email, full_name, phone_e164, status,
         is_platform_super_admin, email_verified, last_login_at, created_at, updated_at`,
      [
        input.email.trim(),
        input.passwordHash ?? null,
        input.fullName.trim(),
        input.phoneE164 ?? null,
        input.status ?? 'PENDING',
        input.isPlatformSuperAdmin ?? false,
        input.emailVerified ?? false,
      ],
    );
    return this.mapUser(res.rows[0]);
  }

  async findUserById(tx: QueryExecutor, userId: string): Promise<UserEntity | null> {
    const res = await tx.query<UserRow>(
      `SELECT
         id, email::text AS email, full_name, phone_e164, status,
         is_platform_super_admin, email_verified, last_login_at, created_at, updated_at
       FROM public.users
       WHERE id = $1`,
      [userId],
    );
    return res.rows[0] ? this.mapUser(res.rows[0]) : null;
  }

  async findUserByEmail(tx: QueryExecutor, email: string): Promise<UserEntity | null> {
    const res = await tx.query<UserRow>(
      `SELECT
         id, email::text AS email, full_name, phone_e164, status,
         is_platform_super_admin, email_verified, last_login_at, created_at, updated_at
       FROM public.users
       WHERE email = $1`,
      [email.trim()],
    );
    return res.rows[0] ? this.mapUser(res.rows[0]) : null;
  }

  async updateUserStatus(
    tx: QueryExecutor,
    userId: string,
    status: UserStatus,
  ): Promise<UserEntity | null> {
    const res = await tx.query<UserRow>(
      `UPDATE public.users
       SET status = $2
       WHERE id = $1
       RETURNING
         id, email::text AS email, full_name, phone_e164, status,
         is_platform_super_admin, email_verified, last_login_at, created_at, updated_at`,
      [userId, status],
    );
    return res.rows[0] ? this.mapUser(res.rows[0]) : null;
  }

  async createTenant(tx: QueryExecutor, input: CreateTenantInput): Promise<TenantEntity> {
    const status = input.status ?? 'PROVISIONING';
    const res = await tx.query<TenantRow>(
      `INSERT INTO public.tenants (
         slug,
         legal_name,
         display_name,
         status,
         default_timezone,
         default_currency,
         activated_at,
         suspended_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4::varchar(24),
         $5,
         $6,
         CASE WHEN $4::varchar(24) = 'ACTIVE' THEN NOW() ELSE NULL END,
         CASE WHEN $4::varchar(24) = 'SUSPENDED' THEN NOW() ELSE NULL END
       )
       RETURNING
         id, slug::text AS slug, legal_name, display_name, status,
         default_timezone, default_currency, activated_at, suspended_at, created_at, updated_at`,
      [
        input.slug.trim().toLowerCase(),
        input.legalName.trim(),
        input.displayName.trim(),
        status,
        input.defaultTimezone ?? 'UTC',
        (input.defaultCurrency ?? 'USD').toUpperCase(),
      ],
    );
    return this.mapTenant(res.rows[0]);
  }

  async findTenantById(tx: QueryExecutor, tenantId: string): Promise<TenantEntity | null> {
    const res = await tx.query<TenantRow>(
      `SELECT
         id, slug::text AS slug, legal_name, display_name, status,
         default_timezone, default_currency, activated_at, suspended_at, created_at, updated_at
       FROM public.tenants
       WHERE id = $1`,
      [tenantId],
    );
    return res.rows[0] ? this.mapTenant(res.rows[0]) : null;
  }

  async updateTenantStatus(
    tx: QueryExecutor,
    tenantId: string,
    status: TenantStatus,
  ): Promise<TenantEntity | null> {
    const res = await tx.query<TenantRow>(
      `UPDATE public.tenants
       SET
         status = $2::varchar(24),
         activated_at = CASE WHEN $2::varchar(24) = 'ACTIVE' AND activated_at IS NULL THEN NOW() ELSE activated_at END,
         suspended_at = CASE WHEN $2::varchar(24) = 'SUSPENDED' THEN NOW() WHEN $2::varchar(24) = 'ACTIVE' THEN NULL ELSE suspended_at END
       WHERE id = $1
       RETURNING
         id, slug::text AS slug, legal_name, display_name, status,
         default_timezone, default_currency, activated_at, suspended_at, created_at, updated_at`,
      [tenantId, status],
    );
    return res.rows[0] ? this.mapTenant(res.rows[0]) : null;
  }

  async listPermissions(
    tx: QueryExecutor,
    scopePlane?: PermissionScopePlane,
  ): Promise<PermissionEntity[]> {
    const res = scopePlane
      ? await tx.query<PermissionRow>(
          `SELECT id, code, scope_plane, module_code, description, created_at, updated_at
           FROM public.permissions
           WHERE scope_plane = $1
           ORDER BY code ASC`,
          [scopePlane],
        )
      : await tx.query<PermissionRow>(
          `SELECT id, code, scope_plane, module_code, description, created_at, updated_at
           FROM public.permissions
           ORDER BY code ASC`,
        );
    return res.rows.map((r) => this.mapPermission(r));
  }

  async createPermission(
    tx: QueryExecutor,
    input: CreatePermissionInput,
  ): Promise<PermissionEntity> {
    const res = await tx.query<PermissionRow>(
      `INSERT INTO public.permissions (code, scope_plane, module_code, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, scope_plane, module_code, description, created_at, updated_at`,
      [
        input.code.trim().toLowerCase(),
        input.scopePlane,
        input.moduleCode.trim(),
        input.description.trim(),
      ],
    );
    return this.mapPermission(res.rows[0]);
  }

  private mapUser(row: UserRow): UserEntity {
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phoneE164: row.phone_e164,
      status: row.status,
      isPlatformSuperAdmin: row.is_platform_super_admin,
      emailVerified: row.email_verified,
      lastLoginAt: toNullableIso(row.last_login_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapTenant(row: TenantRow): TenantEntity {
    return {
      id: row.id,
      slug: row.slug,
      legalName: row.legal_name,
      displayName: row.display_name,
      status: row.status,
      defaultTimezone: row.default_timezone,
      defaultCurrency: row.default_currency.trim(),
      activatedAt: toNullableIso(row.activated_at),
      suspendedAt: toNullableIso(row.suspended_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapPermission(row: PermissionRow): PermissionEntity {
    return {
      id: row.id,
      code: row.code,
      scopePlane: row.scope_plane,
      moduleCode: row.module_code,
      description: row.description,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}
