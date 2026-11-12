import { Injectable } from '@nestjs/common';
import type {
  DataAccessScope,
  PermissionEntity,
  PermissionScopePlane,
  RoleEntity,
  RolePermissionEntity,
  UserRoleAssignmentEntity,
} from '@ft360/shared-types';
import type { QueryExecutor } from '../../database/database.types';

export interface CreateRoleInput {
  tenantId: string;
  slug: string;
  name: string;
  description?: string | null;
  isSystemRole?: boolean;
  dataAccessScope?: DataAccessScope;
}

export interface GrantPermissionInput {
  tenantId: string;
  roleId: string;
  permissionId: string;
}

export interface AssignRoleInput {
  tenantId: string;
  membershipId: string;
  roleId: string;
  assignedByMembershipId?: string | null;
}

interface RoleRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  is_system_role: boolean;
  data_access_scope: DataAccessScope;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RolePermissionRow {
  id: string;
  tenant_id: string;
  role_id: string;
  permission_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AssignmentRow {
  id: string;
  tenant_id: string;
  membership_id: string;
  role_id: string;
  assigned_by_membership_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EffectivePermissionRow {
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

@Injectable()
export class RbacRepository {
  async createRole(tx: QueryExecutor, input: CreateRoleInput): Promise<RoleEntity> {
    const res = await tx.query<RoleRow>(
      `INSERT INTO public.roles (
         tenant_id,
         slug,
         name,
         description,
         is_system_role,
         data_access_scope
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING
         id, tenant_id, slug::text AS slug, name, description,
         is_system_role, data_access_scope, created_at, updated_at`,
      [
        input.tenantId,
        input.slug.trim().toLowerCase(),
        input.name.trim(),
        input.description ?? null,
        input.isSystemRole ?? false,
        input.dataAccessScope ?? 'OWN',
      ],
    );
    return this.mapRole(res.rows[0]);
  }

  async listRoles(tx: QueryExecutor, tenantId: string): Promise<RoleEntity[]> {
    const res = await tx.query<RoleRow>(
      `SELECT
         id, tenant_id, slug::text AS slug, name, description,
         is_system_role, data_access_scope, created_at, updated_at
       FROM public.roles
       WHERE tenant_id = $1
       ORDER BY slug ASC`,
      [tenantId],
    );
    return res.rows.map((r) => this.mapRole(r));
  }

  async grantPermissionToRole(
    tx: QueryExecutor,
    input: GrantPermissionInput,
  ): Promise<RolePermissionEntity> {
    const res = await tx.query<RolePermissionRow>(
      `INSERT INTO public.role_permissions (tenant_id, role_id, permission_id)
       VALUES ($1, $2, $3)
       RETURNING id, tenant_id, role_id, permission_id, created_at, updated_at`,
      [input.tenantId, input.roleId, input.permissionId],
    );
    const row = res.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      roleId: row.role_id,
      permissionId: row.permission_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async assignRoleToMembership(
    tx: QueryExecutor,
    input: AssignRoleInput,
  ): Promise<UserRoleAssignmentEntity> {
    const res = await tx.query<AssignmentRow>(
      `INSERT INTO public.user_role_assignments (
         tenant_id,
         membership_id,
         role_id,
         assigned_by_membership_id
       )
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, membership_id, role_id, assigned_by_membership_id, created_at, updated_at`,
      [
        input.tenantId,
        input.membershipId,
        input.roleId,
        input.assignedByMembershipId ?? null,
      ],
    );
    const row = res.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      membershipId: row.membership_id,
      roleId: row.role_id,
      assignedByMembershipId: row.assigned_by_membership_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  async listEffectivePermissionsForMembership(
    tx: QueryExecutor,
    tenantId: string,
    membershipId: string,
  ): Promise<PermissionEntity[]> {
    const res = await tx.query<EffectivePermissionRow>(
      `SELECT DISTINCT
         p.id, p.code, p.scope_plane, p.module_code, p.description, p.created_at, p.updated_at
       FROM public.user_role_assignments ura
       INNER JOIN public.roles r
         ON r.tenant_id = ura.tenant_id AND r.id = ura.role_id
       INNER JOIN public.role_permissions rp
         ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
       INNER JOIN public.permissions p
         ON p.id = rp.permission_id
       WHERE ura.tenant_id = $1
         AND ura.membership_id = $2
       ORDER BY p.code ASC`,
      [tenantId, membershipId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      code: r.code,
      scopePlane: r.scope_plane,
      moduleCode: r.module_code,
      description: r.description,
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
    }));
  }

  private mapRole(row: RoleRow): RoleEntity {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      isSystemRole: row.is_system_role,
      dataAccessScope: row.data_access_scope,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}
