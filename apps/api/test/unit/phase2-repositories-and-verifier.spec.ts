import type { PoolClient, QueryResult } from 'pg';
import type { DatabasePoolService } from '../../src/database/database-pool.service';
import {
  InvalidTenantContextError,
  UnauthorizedTenantMembershipError,
  type QueryExecutor,
} from '../../src/database/database.types';
import { PostgresTenantMembershipVerifier } from '../../src/database/postgres-tenant-membership.verifier';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { PlatformDirectoryRepository } from '../../src/modules/foundation-db/platform-directory.repository';
import { RbacRepository } from '../../src/modules/foundation-db/rbac.repository';
import { TenantMembershipRepository } from '../../src/modules/foundation-db/tenant-membership.repository';

const USER_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90001';
const TENANT_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90002';
const MEMBERSHIP_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90003';
const ROLE_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90004';
const PERM_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90005';
const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b90099';

function emptyResult<T>(rows: T[]): QueryResult<never> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: rows as never[],
  };
}

describe('Phase 2 Unit Tests: Verifier, Verified Transactions & Parameterized Repositories', () => {
  describe('PostgresTenantMembershipVerifier', () => {
    it('returns null without querying PostgreSQL when userId or tenantId is not a valid UUID', async () => {
      const queryUnscoped = jest.fn();
      const verifier = new PostgresTenantMembershipVerifier({
        queryUnscoped,
      } as unknown as DatabasePoolService);

      await expect(verifier.findMembership('not-a-uuid', TENANT_ID)).resolves.toBeNull();
      await expect(verifier.findMembership(USER_ID, 'drop table tenants')).resolves.toBeNull();
      expect(queryUnscoped).not.toHaveBeenCalled();
    });

    it('queries fn_verify_tenant_membership with normalized parameterized UUIDs and maps statuses', async () => {
      const queryUnscoped = jest.fn().mockResolvedValue(
        emptyResult([
          {
            membership_id: MEMBERSHIP_ID,
            tenant_id: TENANT_ID,
            user_id: USER_ID,
            membership_type: 'INTERNAL',
            membership_status: 'ACTIVE',
            tenant_status: 'TRIAL',
            user_status: 'ACTIVE',
          },
        ]),
      );

      const verifier = new PostgresTenantMembershipVerifier({
        queryUnscoped,
      } as unknown as DatabasePoolService);

      const res = await verifier.findMembership(`  ${USER_ID.toUpperCase()} `, TENANT_ID);
      expect(queryUnscoped).toHaveBeenCalledTimes(1);
      expect(queryUnscoped.mock.calls[0][1]).toEqual([USER_ID, TENANT_ID]);
      expect(res).toEqual({
        membershipId: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'ACTIVE',
        tenantStatus: 'TRIAL',
        userStatus: 'ACTIVE',
      });
    });
  });

  describe('TenantTransactionManager.withVerifiedMemberTransaction', () => {
    function buildMockPool(membershipRows: unknown[]) {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const release = jest.fn();
      const client = {
        query: jest.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes('fn_verify_tenant_membership')) {
            return emptyResult(membershipRows);
          }
          return emptyResult([{ ok: true }]);
        }),
        release,
      } as unknown as PoolClient;

      const dbPool = {
        connectClient: jest.fn().mockResolvedValue(client),
      } as unknown as DatabasePoolService;

      return { dbPool, queries, release };
    }

    it('commits domain callback when user, membership, and tenant are ACTIVE', async () => {
      const { dbPool, queries, release } = buildMockPool([
        {
          membership_id: MEMBERSHIP_ID,
          membership_status: 'ACTIVE',
          tenant_status: 'ACTIVE',
          user_status: 'ACTIVE',
        },
      ]);
      const txManager = new TenantTransactionManager(dbPool);

      const output = await txManager.withVerifiedMemberTransaction(
        { tenantId: TENANT_ID, actorUserId: USER_ID, correlationId: CORR_ID },
        async (tx, verifiedMid) => {
          await tx.query('SELECT 1 FROM public.roles WHERE tenant_id = $1', [TENANT_ID]);
          return verifiedMid;
        },
      );

      expect(output).toBe(MEMBERSHIP_ID);
      expect(queries.some((q) => q.sql === 'COMMIT')).toBe(true);
      expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['missing membership row', []],
      [
        'suspended user',
        [
          {
            membership_id: MEMBERSHIP_ID,
            membership_status: 'ACTIVE',
            tenant_status: 'ACTIVE',
            user_status: 'SUSPENDED',
          },
        ],
      ],
      [
        'revoked membership',
        [
          {
            membership_id: MEMBERSHIP_ID,
            membership_status: 'REVOKED',
            tenant_status: 'ACTIVE',
            user_status: 'ACTIVE',
          },
        ],
      ],
      [
        'suspended tenant',
        [
          {
            membership_id: MEMBERSHIP_ID,
            membership_status: 'ACTIVE',
            tenant_status: 'SUSPENDED',
            user_status: 'ACTIVE',
          },
        ],
      ],
    ])('rolls back and throws UnauthorizedTenantMembershipError on %s', async (_label, rows) => {
      const { dbPool, queries, release } = buildMockPool(rows);
      const txManager = new TenantTransactionManager(dbPool);
      const domainCallback = jest.fn();

      await expect(
        txManager.withVerifiedMemberTransaction(
          { tenantId: TENANT_ID, actorUserId: USER_ID, correlationId: CORR_ID },
          domainCallback,
        ),
      ).rejects.toThrow(UnauthorizedTenantMembershipError);

      expect(domainCallback).not.toHaveBeenCalled();
      expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
      expect(queries.some((q) => q.sql === 'COMMIT')).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid tenant context before acquiring a pooled connection', async () => {
      const connectClient = jest.fn();
      const txManager = new TenantTransactionManager({
        connectClient,
      } as unknown as DatabasePoolService);

      await expect(
        txManager.withVerifiedMemberTransaction(
          { tenantId: '', actorUserId: USER_ID, correlationId: CORR_ID },
          async () => 'never',
        ),
      ).rejects.toThrow(InvalidTenantContextError);

      expect(connectClient).not.toHaveBeenCalled();
    });
  });

  describe('Parameterized Native-SQL Repositories', () => {
    it('PlatformDirectoryRepository uses parameterized SQL for user and tenant creation', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce(
          emptyResult([
            {
              id: USER_ID,
              email: 'alice@example.com',
              full_name: 'Alice Example',
              phone_e164: '+14155550101',
              status: 'ACTIVE',
              is_platform_super_admin: false,
              email_verified: true,
              last_login_at: null,
              created_at: new Date('2026-11-13T00:00:00Z'),
              updated_at: new Date('2026-11-13T00:00:00Z'),
            },
          ]),
        )
        .mockResolvedValueOnce(
          emptyResult([
            {
              id: TENANT_ID,
              slug: 'acme-corp',
              legal_name: 'Acme Corporation Pvt Ltd',
              display_name: 'Acme Corp',
              status: 'ACTIVE',
              default_timezone: 'Asia/Kolkata',
              default_currency: 'INR',
              activated_at: new Date('2026-11-13T00:00:00Z'),
              suspended_at: null,
              created_at: new Date('2026-11-13T00:00:00Z'),
              updated_at: new Date('2026-11-13T00:00:00Z'),
            },
          ]),
        );

      const tx: QueryExecutor = { query };
      const repo = new PlatformDirectoryRepository();

      const user = await repo.createUser(tx, {
        email: '  alice@example.com ',
        fullName: ' Alice Example ',
        phoneE164: '+14155550101',
        status: 'ACTIVE',
        emailVerified: true,
      });
      expect(user.email).toBe('alice@example.com');
      expect(query.mock.calls[0][0]).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7)');

      const tenant = await repo.createTenant(tx, {
        slug: ' ACME-CORP ',
        legalName: 'Acme Corporation Pvt Ltd',
        displayName: 'Acme Corp',
        status: 'ACTIVE',
        defaultTimezone: 'Asia/Kolkata',
        defaultCurrency: 'inr',
      });
      expect(tenant.slug).toBe('acme-corp');
      expect(tenant.defaultCurrency).toBe('INR');
      expect(query.mock.calls[1][1][0]).toBe('acme-corp');
    });

    it('TenantMembershipRepository & RbacRepository execute parameterized tenant-scoped queries', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce(
          emptyResult([
            {
              id: MEMBERSHIP_ID,
              tenant_id: TENANT_ID,
              user_id: USER_ID,
              membership_type: 'INTERNAL',
              status: 'ACTIVE',
              job_title: 'Sales Lead',
              employee_code: 'EMP-01',
              invited_by_user_id: null,
              joined_at: '2026-11-13T00:00:00.000Z',
              created_at: '2026-11-13T00:00:00.000Z',
              updated_at: '2026-11-13T00:00:00.000Z',
            },
          ]),
        )
        .mockResolvedValueOnce(
          emptyResult([
            {
              id: ROLE_ID,
              tenant_id: TENANT_ID,
              slug: 'sales_manager',
              name: 'Sales Manager',
              description: 'Manages sales team',
              is_system_role: true,
              data_access_scope: 'TEAM',
              created_at: '2026-11-13T00:00:00.000Z',
              updated_at: '2026-11-13T00:00:00.000Z',
            },
          ]),
        )
        .mockResolvedValueOnce(
          emptyResult([
            {
              id: '0195f3a2-7c40-7b12-9a10-4e8d21b90006',
              tenant_id: TENANT_ID,
              role_id: ROLE_ID,
              permission_id: PERM_ID,
              created_at: '2026-11-13T00:00:00.000Z',
              updated_at: '2026-11-13T00:00:00.000Z',
            },
          ]),
        )
        .mockResolvedValueOnce(
          emptyResult([
            {
              id: '0195f3a2-7c40-7b12-9a10-4e8d21b90007',
              tenant_id: TENANT_ID,
              membership_id: MEMBERSHIP_ID,
              role_id: ROLE_ID,
              assigned_by_membership_id: null,
              created_at: '2026-11-13T00:00:00.000Z',
              updated_at: '2026-11-13T00:00:00.000Z',
            },
          ]),
        );

      const tx: QueryExecutor = { query };
      const membershipRepo = new TenantMembershipRepository({
        queryUnscoped: jest.fn().mockResolvedValue(emptyResult([])),
      } as unknown as DatabasePoolService);
      const rbacRepo = new RbacRepository();

      const member = await membershipRepo.createMembership(tx, {
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'ACTIVE',
        jobTitle: 'Sales Lead',
        employeeCode: 'EMP-01',
      });
      expect(member.id).toBe(MEMBERSHIP_ID);

      const role = await rbacRepo.createRole(tx, {
        tenantId: TENANT_ID,
        slug: 'Sales_Manager',
        name: 'Sales Manager',
        isSystemRole: true,
        dataAccessScope: 'TEAM',
      });
      expect(role.slug).toBe('sales_manager');

      const rp = await rbacRepo.grantPermissionToRole(tx, {
        tenantId: TENANT_ID,
        roleId: ROLE_ID,
        permissionId: PERM_ID,
      });
      expect(rp.permissionId).toBe(PERM_ID);

      const ura = await rbacRepo.assignRoleToMembership(tx, {
        tenantId: TENANT_ID,
        membershipId: MEMBERSHIP_ID,
        roleId: ROLE_ID,
      });
      expect(ura.membershipId).toBe(MEMBERSHIP_ID);
      expect(query).toHaveBeenCalledTimes(4);
    });
  });
});
