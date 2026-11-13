import {
  Controller,
  Get,
  Req,
  UseGuards,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import type {
  PermissionEntity,
  RoleEntity,
  TenantEntity,
  TenantMembershipEntity,
  UserEntity,
} from '@ft360/shared-types';
import { AppModule } from '../../src/app.module';
import { configureNestApp } from '../../src/bootstrap';
import { Public } from '../../src/common/auth.decorators';
import {
  TenantMembershipGuard,
  type RequestWithVerifiedTenant,
} from '../../src/common/tenant-membership.guard';
import { APP_CONFIG, loadAppConfig, type AppEnvConfig } from '../../src/config/env.config';
import { DatabasePoolService } from '../../src/database/database-pool.service';
import {
  InvalidTenantContextError,
  UnauthorizedTenantMembershipError,
} from '../../src/database/database.types';
import { SqlMigrationRunner } from '../../src/database/migrations/migration-runner';
import { PostgresTenantMembershipVerifier } from '../../src/database/postgres-tenant-membership.verifier';
import { TenantTransactionManager } from '../../src/database/tenant-transaction.manager';
import { PlatformDirectoryRepository } from '../../src/modules/foundation-db/platform-directory.repository';
import { RbacRepository } from '../../src/modules/foundation-db/rbac.repository';
import { TenantMembershipRepository } from '../../src/modules/foundation-db/tenant-membership.repository';

const CORR_ID = '0195f3a2-7c40-7b12-9a10-4e8d21b9f999';

@Public()
@Controller('_test-phase2-guard')
class Phase2GuardProbeController {
  @Get('context')
  @UseGuards(TenantMembershipGuard)
  getVerifiedContext(@Req() req: RequestWithVerifiedTenant) {
    return {
      tenantContext: req.tenantContext,
    };
  }
}

@Module({
  controllers: [Phase2GuardProbeController],
})
class Phase2GuardProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: RequestWithVerifiedTenant, _res: Response, next: NextFunction) => {
        const uid = req.headers['x-test-auth-user'];
        const tid = req.headers['x-test-auth-active-tenant'];
        if (typeof uid === 'string' && typeof tid === 'string') {
          req.authSession = { userId: uid, activeTenantId: tid };
        }
        next();
      })
      .forRoutes(Phase2GuardProbeController);
  }
}

describe('Phase 2 Database Foundation, Clean Migrations, Composite FKs & Mandatory Negative RLS Suite', () => {
  let app: INestApplication;
  let config: AppEnvConfig;
  let dbPool: DatabasePoolService;
  let txManager: TenantTransactionManager;
  let verifier: PostgresTenantMembershipVerifier;
  let platformRepo: PlatformDirectoryRepository;
  let membershipRepo: TenantMembershipRepository;
  let rbacRepo: RbacRepository;

  // Seeded fixtures across Tenant A, Tenant B, and Global Platform
  let userSuperAdmin: UserEntity;
  let userAlphaAdmin: UserEntity;
  let userAlphaMember: UserEntity;
  let userBetaAdmin: UserEntity;
  let userSharedMultiOrg: UserEntity;
  let userPendingGlobal: UserEntity;
  let userActiveWithSuspendedAndInvitedMemberships: UserEntity;

  let tenantAlpha: TenantEntity;
  let tenantBeta: TenantEntity;
  let tenantSuspended: TenantEntity;

  let memberAlphaAdmin: TenantMembershipEntity;
  let memberAlphaSecondary: TenantMembershipEntity;
  let memberBetaAdmin: TenantMembershipEntity;
  let memberSharedInAlpha: TenantMembershipEntity;
  let memberSharedInBeta: TenantMembershipEntity;
  let memberSuspendedInAlpha: TenantMembershipEntity;
  let memberInSuspendedTenant: TenantMembershipEntity;

  let roleAlphaAdmin: RoleEntity;
  let roleBetaAdmin: RoleEntity;
  let permTenantMembersRead: PermissionEntity;
  let permRbacRolesManage: PermissionEntity;
  let permPlatformTenantsManage: PermissionEntity;

  beforeAll(async () => {
    config = loadAppConfig();

    // =========================================================================
    // 1. Clean Database Migration + Full Rollback & Reapplication Verification
    // =========================================================================
    const runner = new SqlMigrationRunner(config.database.migratorUrl);
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 2 });
    try {
      // Ensure current state is migrated, then roll back ALL migrations down to a clean DB
      const discoveredNames = runner.discoverMigrations().map((m) => m.name);
      expect(discoveredNames.slice(0, 4)).toEqual([
        '0001_foundation_rls_helpers',
        '0002_foundation_branding_and_rls_canary',
        '0003_users_tenants_and_memberships',
        '0004_rbac_roles_permissions_and_assignments',
      ]);

      await runner.migrateUp();
      const rolledBackOrder: string[] = [];
      while (true) {
        const rolled = await runner.rollbackLatest();
        if (!rolled) break;
        rolledBackOrder.push(rolled);
      }
      expect(rolledBackOrder).toEqual([...discoveredNames].reverse());

      // Confirm clean database state (only schema_migrations ledger remains)
      const remainingTables = await migratorPool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC`,
      );
      expect(remainingTables.rows.map((r) => r.tablename)).toEqual(['schema_migrations']);

      // Apply all migrations from clean state
      const appliedFromClean = await runner.migrateUp();
      expect(appliedFromClean).toEqual(discoveredNames);

      // Verify rollback down past Phase 2 (through 0003) and clean reapplication
      const postPhase1Migrations = discoveredNames.slice(2);
      for (const expectedName of [...postPhase1Migrations].reverse()) {
        expect(await runner.rollbackLatest()).toBe(expectedName);
      }
      expect(await runner.migrateUp()).toEqual(postPhase1Migrations);
    } finally {
      await migratorPool.end();
      await runner.close();
    }

    // =========================================================================
    // 2. Boot NestJS Application & Seed Multi-Tenant Fixtures via Repositories
    // =========================================================================
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, Phase2GuardProbeModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue({ ...config, database: { ...config.database, poolMin: 1, poolMax: 6 } })
      .compile();

    app = moduleRef.createNestApplication();
    configureNestApp(app);
    await app.init();

    dbPool = app.get(DatabasePoolService);
    txManager = app.get(TenantTransactionManager);
    verifier = app.get(PostgresTenantMembershipVerifier);
    platformRepo = app.get(PlatformDirectoryRepository);
    membershipRepo = app.get(TenantMembershipRepository);
    rbacRepo = app.get(RbacRepository);

    // Bootstrap Platform Super Admin account first via system bootstrap transaction
    await txManager.withSystemBootstrapTransaction(async (tx) => {
      userSuperAdmin = await platformRepo.createUser(tx, {
        email: 'platform.root@phase2.test',
        fullName: 'Platform Super Admin',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockhashsuperadmin',
        status: 'ACTIVE',
        isPlatformSuperAdmin: true,
        emailVerified: true,
      });
    });

    // Seed global users & tenants via verified Platform Super Admin transaction
    await txManager.withPlatformAdminTransaction(userSuperAdmin.id, async (tx) => {
      userAlphaAdmin = await platformRepo.createUser(tx, {
        email: 'alpha.admin@phase2.test',
        fullName: 'Alpha Admin',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockhashalpha',
        phoneE164: '+14155551001',
        status: 'ACTIVE',
        emailVerified: true,
      });
      userAlphaMember = await platformRepo.createUser(tx, {
        email: 'alpha.member@phase2.test',
        fullName: 'Alpha Secondary Member',
        status: 'ACTIVE',
        emailVerified: true,
      });
      userBetaAdmin = await platformRepo.createUser(tx, {
        email: 'beta.admin@phase2.test',
        fullName: 'Beta Admin',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockhashbeta',
        phoneE164: '+14155552002',
        status: 'ACTIVE',
        emailVerified: true,
      });
      userSharedMultiOrg = await platformRepo.createUser(tx, {
        email: 'shared.consultant@phase2.test',
        fullName: 'Shared Multi-Org Consultant',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$mockhashshared',
        status: 'ACTIVE',
        emailVerified: true,
      });
      userPendingGlobal = await platformRepo.createUser(tx, {
        email: 'pending.user@phase2.test',
        fullName: 'Pending User',
        status: 'PENDING',
      });
      userActiveWithSuspendedAndInvitedMemberships = await platformRepo.createUser(tx, {
        email: 'suspended.member@phase2.test',
        fullName: 'Active User With Non-Active Memberships',
        status: 'ACTIVE',
        emailVerified: false,
      });

      tenantAlpha = await platformRepo.createTenant(tx, {
        slug: 'tenant-alpha-p2',
        legalName: 'Tenant Alpha Technologies Pvt Ltd',
        displayName: 'Tenant Alpha',
        status: 'ACTIVE',
        defaultTimezone: 'Asia/Kolkata',
        defaultCurrency: 'INR',
      });
      tenantBeta = await platformRepo.createTenant(tx, {
        slug: 'tenant-beta-p2',
        legalName: 'Tenant Beta Holdings LLC',
        displayName: 'Tenant Beta',
        status: 'ACTIVE',
        defaultTimezone: 'UTC',
        defaultCurrency: 'USD',
      });
      tenantSuspended = await platformRepo.createTenant(tx, {
        slug: 'tenant-suspended-p2',
        legalName: 'Suspended Org Inc',
        displayName: 'Suspended Org',
        status: 'SUSPENDED',
      });

      const allPerms = await platformRepo.listPermissions(tx);
      permTenantMembersRead = allPerms.find((p) => p.code === 'tenant:members:read')!;
      permRbacRolesManage = allPerms.find((p) => p.code === 'rbac:roles:manage')!;
      permPlatformTenantsManage = allPerms.find((p) => p.code === 'platform:tenants:manage')!;

      // Bootstrap initial admin memberships
      memberAlphaAdmin = await membershipRepo.createMembership(tx, {
        tenantId: tenantAlpha.id,
        userId: userAlphaAdmin.id,
        status: 'ACTIVE',
        jobTitle: 'VP Operations',
        employeeCode: 'ALPHA-001',
      });
      memberBetaAdmin = await membershipRepo.createMembership(tx, {
        tenantId: tenantBeta.id,
        userId: userBetaAdmin.id,
        status: 'ACTIVE',
        jobTitle: 'Managing Director',
        employeeCode: 'BETA-001',
      });
      memberInSuspendedTenant = await membershipRepo.createMembership(tx, {
        tenantId: tenantSuspended.id,
        userId: userAlphaAdmin.id,
        status: 'ACTIVE',
      });
    });

    // Seed Tenant Alpha memberships, roles, permissions, and assignments inside verified Tenant Alpha tx
    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantAlpha.id,
        actorUserId: userAlphaAdmin.id,
        membershipId: memberAlphaAdmin.id,
        correlationId: CORR_ID,
      },
      async (tx) => {
        memberAlphaSecondary = await membershipRepo.createMembership(tx, {
          tenantId: tenantAlpha.id,
          userId: userAlphaMember.id,
          status: 'ACTIVE',
          employeeCode: 'ALPHA-002',
          invitedByUserId: userAlphaAdmin.id,
        });
        memberSharedInAlpha = await membershipRepo.createMembership(tx, {
          tenantId: tenantAlpha.id,
          userId: userSharedMultiOrg.id,
          membershipType: 'PARTNER',
          status: 'ACTIVE',
        });
        memberSuspendedInAlpha = await membershipRepo.createMembership(tx, {
          tenantId: tenantAlpha.id,
          userId: userPendingGlobal.id,
          status: 'SUSPENDED',
        });
        await membershipRepo.createMembership(tx, {
          tenantId: tenantAlpha.id,
          userId: userActiveWithSuspendedAndInvitedMemberships.id,
          status: 'SUSPENDED',
        });

        // Verify 2-character role slug ('hr') is accepted by chk_roles_slug_format
        await rbacRepo.createRole(tx, {
          tenantId: tenantAlpha.id,
          slug: 'hr',
          name: 'HR Operations',
          isSystemRole: false,
          dataAccessScope: 'TEAM',
        });

        roleAlphaAdmin = await rbacRepo.createRole(tx, {
          tenantId: tenantAlpha.id,
          slug: 'tenant_admin',
          name: 'Tenant Administrator',
          isSystemRole: true,
          dataAccessScope: 'TENANT',
        });

        await rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantAlpha.id,
          roleId: roleAlphaAdmin.id,
          permissionId: permTenantMembersRead.id,
        });
        await rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantAlpha.id,
          roleId: roleAlphaAdmin.id,
          permissionId: permRbacRolesManage.id,
        });

        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantAlpha.id,
          membershipId: memberAlphaAdmin.id,
          roleId: roleAlphaAdmin.id,
          assignedByMembershipId: memberAlphaSecondary.id,
        });
      },
    );

    // Seed Tenant Beta memberships, roles (using identical slug 'tenant_admin'!), and assignments
    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantBeta.id,
        actorUserId: userBetaAdmin.id,
        membershipId: memberBetaAdmin.id,
        correlationId: CORR_ID,
      },
      async (tx) => {
        memberSharedInBeta = await membershipRepo.createMembership(tx, {
          tenantId: tenantBeta.id,
          userId: userSharedMultiOrg.id,
          membershipType: 'CLIENT_PORTAL',
          status: 'ACTIVE',
        });
        // Unaccepted INVITED membership in Tenant Beta: must NOT expose global user profile to Beta
        await membershipRepo.createMembership(tx, {
          tenantId: tenantBeta.id,
          userId: userActiveWithSuspendedAndInvitedMemberships.id,
          status: 'INVITED',
        });

        roleBetaAdmin = await rbacRepo.createRole(tx, {
          tenantId: tenantBeta.id,
          slug: 'tenant_admin',
          name: 'Beta Organization Admin',
          isSystemRole: true,
          dataAccessScope: 'TENANT',
        });

        await rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantBeta.id,
          roleId: roleBetaAdmin.id,
          permissionId: permTenantMembersRead.id,
        });

        await rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantBeta.id,
          membershipId: memberBetaAdmin.id,
          roleId: roleBetaAdmin.id,
        });
      },
    );
  });

  afterAll(async () => {
    // Clean up Phase 2 test fixtures cleanly via migrator role
    const cleanupPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      await cleanupPool.query(
        `DELETE FROM public.tenants WHERE slug IN ('tenant-alpha-p2', 'tenant-beta-p2', 'tenant-suspended-p2', 'uk')`,
      );
      await cleanupPool.query(`DELETE FROM public.users WHERE email LIKE '%@phase2.test'`);
    } finally {
      await cleanupPool.end();
    }
    if (app) {
      await app.close();
    }
  });

  it('verifies database role separation, FORCE RLS on 100% of tables, composite FKs, indexes, and updated_at triggers', async () => {
    const expectedTables = [
      'permissions',
      'platform_branding_settings',
      'rls_isolation_canary',
      'role_permissions',
      'roles',
      'tenant_memberships',
      'tenants',
      'user_role_assignments',
      'users',
    ];

    const catalog = await dbPool.queryUnscoped<{
      tablename: string;
      tableowner: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT
         t.tablename,
         t.tableowner,
         c.relrowsecurity,
         c.relforcerowsecurity
       FROM pg_tables t
       INNER JOIN pg_class c ON c.relname = t.tablename
       INNER JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
       WHERE t.schemaname = 'public'
         AND t.tablename <> 'schema_migrations'
       ORDER BY t.tablename ASC`,
    );

    expect(catalog.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(expectedTables));
    for (const row of catalog.rows) {
      expect(row.tableowner).toBe('ft360_migrator');
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // Automated completeness check: 0 tables with tenant_id lack ENABLE + FORCE RLS
    const unprotectedTenantTables = await dbPool.queryUnscoped<{ table_name: string }>(
      `SELECT ic.table_name
       FROM information_schema.columns ic
       INNER JOIN pg_class c ON c.relname = ic.table_name
       INNER JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = ic.table_schema
       WHERE ic.table_schema = 'public'
         AND ic.column_name = 'tenant_id'
         AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)`,
    );
    expect(unprotectedTenantTables.rows).toEqual([]);

    // Verify all composite foreign keys exist in pg_constraint
    const compositeFks = await dbPool.queryUnscoped<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint
       WHERE contype = 'f'
         AND array_length(conkey, 1) >= 2
       ORDER BY conname ASC`,
    );
    expect(compositeFks.rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'fk_role_permissions_tenant_role',
        'fk_ura_assigned_by_membership',
        'fk_ura_tenant_membership',
        'fk_ura_tenant_role',
      ]),
    );

    // Verify unique constraints (case-insensitive email & slug), 2-char tenant slug ('uk'), + updated_at trigger
    await expect(
      txManager.withPlatformAdminTransaction(userSuperAdmin.id, (tx) =>
        platformRepo.createUser(tx, {
          email: 'ALPHA.ADMIN@PHASE2.TEST',
          fullName: 'Duplicate Case-Insensitive Email',
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      txManager.withPlatformAdminTransaction(userSuperAdmin.id, (tx) =>
        platformRepo.createTenant(tx, {
          slug: 'TENANT-ALPHA-P2',
          legalName: 'Duplicate Slug',
          displayName: 'Duplicate Slug',
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Non-super-admin UUID cannot invoke withPlatformAdminTransaction
    await expect(
      txManager.withPlatformAdminTransaction(userAlphaAdmin.id, async () => 'never'),
    ).rejects.toThrow(UnauthorizedTenantMembershipError);

    await txManager.withPlatformAdminTransaction(userSuperAdmin.id, async (tx) => {
      const twoCharTenant = await platformRepo.createTenant(tx, {
        slug: 'uk',
        legalName: 'UK Regional Subsidiary Ltd',
        displayName: 'UK Ops',
        status: 'TRIAL',
      });
      expect(twoCharTenant.slug).toBe('uk');

      const beforeUpdate = userAlphaAdmin.updatedAt;
      await new Promise((r) => setTimeout(r, 15));
      const updatedTenant = await platformRepo.updateTenantStatus(tx, tenantBeta.id, 'TRIAL');
      expect(updatedTenant?.status).toBe('TRIAL');
      expect(new Date(updatedTenant!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeUpdate).getTime(),
      );
      await platformRepo.updateTenantStatus(tx, tenantBeta.id, 'ACTIVE');
    });

    // Even Platform Super Admin cannot DELETE global root rows (DELETE omitted from ft360_app grants -> 42501)
    for (const protectedRootTable of ['users', 'tenants', 'permissions']) {
      await expect(
        txManager.withPlatformAdminTransaction(userSuperAdmin.id, (tx) =>
          tx.query(`DELETE FROM public.${protectedRootTable}`),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('prevents Tenant A from reading, updating, deleting, or inserting Tenant B records AND protects global platform records', async () => {
    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantAlpha.id,
        actorUserId: userAlphaAdmin.id,
        membershipId: memberAlphaAdmin.id,
        correlationId: CORR_ID,
      },
      async (tx) => {
        // 1. Tenant A CANNOT read Tenant B records across any table
        expect(await platformRepo.findTenantById(tx, tenantBeta.id)).toBeNull();
        expect(await platformRepo.findUserById(tx, userBetaAdmin.id)).toBeNull();
        // Shared multi-org user IS visible as a co-member of Tenant Alpha, while Beta-only user is NOT
        expect((await platformRepo.findUserById(tx, userSharedMultiOrg.id))?.id).toBe(
          userSharedMultiOrg.id,
        );
        expect(
          await membershipRepo.findMembershipById(tx, tenantBeta.id, memberSharedInBeta.id),
        ).toBeNull();
        expect(
          (await membershipRepo.findMembershipById(tx, tenantAlpha.id, memberSuspendedInAlpha.id))
            ?.status,
        ).toBe('SUSPENDED');

        const visibleMemberships = await tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM public.tenant_memberships`,
        );
        expect(visibleMemberships.rows.length).toBeGreaterThanOrEqual(3);
        expect(visibleMemberships.rows.every((r) => r.tenant_id === tenantAlpha.id)).toBe(true);

        const visibleRoles = await rbacRepo.listRoles(tx, tenantBeta.id);
        expect(visibleRoles).toEqual([]);
        const allVisibleRoles = await tx.query<{ tenant_id: string }>(`SELECT tenant_id FROM public.roles`);
        expect(allVisibleRoles.rows.every((r) => r.tenant_id === tenantAlpha.id)).toBe(true);

        const allVisibleRolePerms = await tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM public.role_permissions`,
        );
        expect(allVisibleRolePerms.rows.every((r) => r.tenant_id === tenantAlpha.id)).toBe(true);

        const allVisibleAssignments = await tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM public.user_role_assignments`,
        );
        expect(allVisibleAssignments.rows.every((r) => r.tenant_id === tenantAlpha.id)).toBe(true);

        // Effective permissions resolution returns Tenant Alpha's granted permissions
        const effectivePerms = await rbacRepo.listEffectivePermissionsForMembership(
          tx,
          tenantAlpha.id,
          memberAlphaAdmin.id,
        );
        expect(effectivePerms.map((p) => p.code)).toEqual([
          'rbac:roles:manage',
          'tenant:members:read',
        ]);

        // 2. Tenant A CANNOT update Tenant B records (0 rows affected)
        const updTenantB = await tx.query(
          `UPDATE public.tenants SET display_name = 'Hijacked' WHERE id = $1`,
          [tenantBeta.id],
        );
        expect(updTenantB.rowCount).toBe(0);

        const updUserB = await tx.query(
          `UPDATE public.users SET full_name = 'Hijacked' WHERE id = $1`,
          [userBetaAdmin.id],
        );
        expect(updUserB.rowCount).toBe(0);

        // Tenant A admin cannot even update a shared multi-org user's global profile (only self or Super Admin!)
        const updSharedUser = await tx.query(
          `UPDATE public.users SET full_name = 'Hijacked Shared' WHERE id = $1`,
          [userSharedMultiOrg.id],
        );
        expect(updSharedUser.rowCount).toBe(0);

        const updMemberB = await tx.query(
          `UPDATE public.tenant_memberships SET status = 'REVOKED' WHERE id = $1`,
          [memberBetaAdmin.id],
        );
        expect(updMemberB.rowCount).toBe(0);

        const updRoleB = await tx.query(
          `UPDATE public.roles SET name = 'Hijacked' WHERE id = $1`,
          [roleBetaAdmin.id],
        );
        expect(updRoleB.rowCount).toBe(0);

        // 3. Tenant A CANNOT delete Tenant B records (0 rows affected)
        expect(
          (await tx.query(`DELETE FROM public.tenant_memberships WHERE id = $1`, [memberBetaAdmin.id]))
            .rowCount,
        ).toBe(0);
        expect(
          (await tx.query(`DELETE FROM public.roles WHERE id = $1`, [roleBetaAdmin.id])).rowCount,
        ).toBe(0);
        expect(
          (await tx.query(`DELETE FROM public.role_permissions WHERE role_id = $1`, [roleBetaAdmin.id]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await tx.query(`DELETE FROM public.user_role_assignments WHERE membership_id = $1`, [
              memberBetaAdmin.id,
            ])
          ).rowCount,
        ).toBe(0);
      },
    );

    const alphaCtx = {
      tenantId: tenantAlpha.id,
      actorUserId: userAlphaAdmin.id,
      membershipId: memberAlphaAdmin.id,
      correlationId: CORR_ID,
    };

    // 4. Tenant A CANNOT insert records tagged with or referencing Tenant B (42501 RLS violation + rollback)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        membershipRepo.createMembership(tx, {
          tenantId: tenantBeta.id,
          userId: userAlphaAdmin.id,
          status: 'ACTIVE',
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        rbacRepo.createRole(tx, {
          tenantId: tenantBeta.id,
          slug: 'forged_role',
          name: 'Forged Role',
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantBeta.id,
          roleId: roleBetaAdmin.id,
          permissionId: permTenantMembersRead.id,
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        rbacRepo.assignRoleToMembership(tx, {
          tenantId: tenantBeta.id,
          membershipId: memberBetaAdmin.id,
          roleId: roleBetaAdmin.id,
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 5. Global platform records are protected from tenant writes & privilege escalation
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        platformRepo.createPermission(tx, {
          code: 'crm:forged:admin',
          scopePlane: 'TENANT',
          moduleCode: 'M07',
          description: 'Tenant trying to mutate global permission catalog',
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        platformRepo.createTenant(tx, {
          slug: 'rogue-tenant-from-alpha',
          legalName: 'Rogue Org',
          displayName: 'Rogue Org',
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Self-escalation to platform super admin or changing own tenant lifecycle status blocked (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tx.query(`UPDATE public.users SET is_platform_super_admin = TRUE WHERE id = $1`, [
          userAlphaAdmin.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tx.query(`UPDATE public.users SET email_verified = FALSE WHERE id = $1`, [
          userAlphaAdmin.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Column-level SELECT omits password_hash: even valid tenant tx cannot read password_hash (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tx.query(`SELECT password_hash FROM public.users WHERE id = $1`, [userAlphaAdmin.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Protected system roles (is_system_role = TRUE) cannot be deleted or slug-tampered by tenant tx (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tx.query(`DELETE FROM public.roles WHERE id = $1`, [roleAlphaAdmin.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Unaccepted INVITED user profile in Tenant Beta is NOT visible to Tenant Beta queries
    await txManager.withVerifiedMemberTransaction(
      {
        tenantId: tenantBeta.id,
        actorUserId: userBetaAdmin.id,
        membershipId: memberBetaAdmin.id,
        correlationId: CORR_ID,
      },
      async (tx) => {
        expect(
          await platformRepo.findUserById(tx, userActiveWithSuspendedAndInvitedMemberships.id),
        ).toBeNull();
      },
    );

    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        tx.query(`UPDATE public.tenants SET status = 'CANCELLED' WHERE id = $1`, [tenantAlpha.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Granting PLATFORM-plane permission to a tenant role blocked by trigger (42501)
    await expect(
      txManager.withVerifiedMemberTransaction(alphaCtx, (tx) =>
        rbacRepo.grantPermissionToRole(tx, {
          tenantId: tenantAlpha.id,
          roleId: roleAlphaAdmin.id,
          permissionId: permPlatformTenantsManage.id,
        }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects missing and invalid tenant context (fail-closed) across all 7 Phase 2 tables', async () => {
    const phase2Tables = [
      'users',
      'tenants',
      'tenant_memberships',
      'permissions',
      'roles',
      'role_permissions',
      'user_role_assignments',
    ];

    // 1. Missing context bypassing TenantTransactionManager -> 0 rows on SELECT across ALL 7 tables
    for (const table of phase2Tables) {
      const res = await dbPool.queryUnscoped(`SELECT id FROM public.${table}`);
      expect(res.rows).toHaveLength(0);
    }

    // Unscoped INSERT into roles rejected with 42501
    await expect(
      dbPool.queryUnscoped(
        `INSERT INTO public.roles (tenant_id, slug, name) VALUES ($1, 'unscoped_role', 'Unscoped')`,
        [tenantAlpha.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // 2. Invalid tenant context rejected by TenantTransactionManager AND fail-closed in SQL
    await expect(
      txManager.withVerifiedMemberTransaction(
        { tenantId: '', actorUserId: userAlphaAdmin.id, correlationId: CORR_ID },
        async () => 'never',
      ),
    ).rejects.toThrow(InvalidTenantContextError);

    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: "' OR '1'='1",
          actorUserId: userAlphaAdmin.id,
          correlationId: CORR_ID,
        },
        async () => 'never',
      ),
    ).rejects.toThrow(InvalidTenantContextError);

    const client = await dbPool.connectClient();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', 'invalid-uuid-value', true)`);
      await client.query(`SELECT set_config('app.current_user_id', 'invalid-uuid-value', true)`);
      for (const table of phase2Tables) {
        const res = await client.query(`SELECT COUNT(*)::int AS cnt FROM public.${table}`);
        expect(res.rows[0].cnt).toBe(0);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rejects unauthorized, cross-tenant, suspended, or inactive memberships in both Guard and Transaction Manager', async () => {
    // Workspace discovery returns ONLY active/trial tenants for multi-org user (and excludes suspended tenants)
    const alphaAdminTenants = await membershipRepo.listUserActiveTenants(userAlphaAdmin.id);
    expect(alphaAdminTenants.map((t) => t.tenantId)).toEqual([tenantAlpha.id]);

    const sharedTenants = await membershipRepo.listUserActiveTenants(userSharedMultiOrg.id);
    expect(sharedTenants.map((t) => t.tenantId).sort()).toEqual(
      [tenantAlpha.id, tenantBeta.id].sort(),
    );

    // 1. Active user in Tenant Alpha attempting access to Tenant Beta (wrong membership)
    await expect(
      txManager.withVerifiedMemberTransaction(
        { tenantId: tenantBeta.id, actorUserId: userAlphaAdmin.id, correlationId: CORR_ID },
        async () => 'never',
      ),
    ).rejects.toThrow(UnauthorizedTenantMembershipError);

    const wrongTenantHttp = await request(app.getHttpServer())
      .get('/api/v1/_test-phase2-guard/context')
      .set('x-test-auth-user', userAlphaAdmin.id)
      .set('x-test-auth-active-tenant', tenantBeta.id)
      .expect(403);
    expect(wrongTenantHttp.body.error.code).toBe('TENANT_MEMBERSHIP_DENIED');

    // 2. Pending user attempting access -> USER_ACCOUNT_INACTIVE; ACTIVE user with SUSPENDED/INVITED membership -> TENANT_MEMBERSHIP_INACTIVE
    await expect(
      txManager.withVerifiedMemberTransaction(
        { tenantId: tenantAlpha.id, actorUserId: userPendingGlobal.id, correlationId: CORR_ID },
        async () => 'never',
      ),
    ).rejects.toThrow(UnauthorizedTenantMembershipError);

    const inactiveUserHttp = await request(app.getHttpServer())
      .get('/api/v1/_test-phase2-guard/context')
      .set('x-test-auth-user', userPendingGlobal.id)
      .set('x-test-auth-active-tenant', tenantAlpha.id)
      .expect(403);
    expect(inactiveUserHttp.body.error.code).toBe('USER_ACCOUNT_INACTIVE');

    // ACTIVE user with SUSPENDED membership in Alpha and INVITED membership in Beta
    expect(
      await membershipRepo.listUserActiveTenants(userActiveWithSuspendedAndInvitedMemberships.id),
    ).toEqual([]);

    const suspendedMembershipHttp = await request(app.getHttpServer())
      .get('/api/v1/_test-phase2-guard/context')
      .set('x-test-auth-user', userActiveWithSuspendedAndInvitedMemberships.id)
      .set('x-test-auth-active-tenant', tenantAlpha.id)
      .expect(403);
    expect(suspendedMembershipHttp.body.error.code).toBe('TENANT_MEMBERSHIP_INACTIVE');

    const invitedMembershipHttp = await request(app.getHttpServer())
      .get('/api/v1/_test-phase2-guard/context')
      .set('x-test-auth-user', userActiveWithSuspendedAndInvitedMemberships.id)
      .set('x-test-auth-active-tenant', tenantBeta.id)
      .expect(403);
    expect(invitedMembershipHttp.body.error.code).toBe('TENANT_MEMBERSHIP_INACTIVE');

    // 3. Active user attempting access to a SUSPENDED tenant (even with ACTIVE membership row)
    await expect(
      txManager.withVerifiedMemberTransaction(
        {
          tenantId: tenantSuspended.id,
          actorUserId: userAlphaAdmin.id,
          membershipId: memberInSuspendedTenant.id,
          correlationId: CORR_ID,
        },
        async () => 'never',
      ),
    ).rejects.toThrow(UnauthorizedTenantMembershipError);

    const suspendedTenantHttp = await request(app.getHttpServer())
      .get('/api/v1/_test-phase2-guard/context')
      .set('x-test-auth-user', userAlphaAdmin.id)
      .set('x-test-auth-active-tenant', tenantSuspended.id)
      .expect(403);
    expect(suspendedTenantHttp.body.error.code).toBe('TENANT_SUSPENDED_OR_INACTIVE');

    // 4. Positive control: valid active member in active tenant succeeds via real Postgres verifier
    const validRecord = await verifier.findMembership(userAlphaAdmin.id, tenantAlpha.id);
    expect(validRecord?.membershipId).toBe(memberAlphaAdmin.id);

    const okHttp = await request(app.getHttpServer())
      .get('/api/v1/_test-phase2-guard/context')
      .set('x-test-auth-user', userAlphaAdmin.id)
      .set('x-test-auth-active-tenant', tenantAlpha.id)
      .expect(200);
    expect(okHttp.body.data.tenantContext).toMatchObject({
      tenantId: tenantAlpha.id,
      actorUserId: userAlphaAdmin.id,
      membershipId: memberAlphaAdmin.id,
    });
  });

  it('rejects cross-tenant composite foreign key violations (23503) even when RLS is bypassed by migrator role', async () => {
    // Use migrator connection directly to prove database-level composite FK integrity
    // independently of ft360_app RLS policies!
    const migratorPool = new Pool({ connectionString: config.database.migratorUrl, max: 1 });
    try {
      // 1. role_permissions: Tenant Alpha tenant_id + Tenant Beta role_id -> 23503
      await expect(
        migratorPool.query(
          `INSERT INTO public.role_permissions (tenant_id, role_id, permission_id)
           VALUES ($1, $2, $3)`,
          [tenantAlpha.id, roleBetaAdmin.id, permTenantMembersRead.id],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_role_permissions_tenant_role',
      });

      // 2. user_role_assignments: Tenant Alpha tenant_id + Tenant Beta membership_id -> 23503
      await expect(
        migratorPool.query(
          `INSERT INTO public.user_role_assignments (tenant_id, membership_id, role_id)
           VALUES ($1, $2, $3)`,
          [tenantAlpha.id, memberBetaAdmin.id, roleAlphaAdmin.id],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_ura_tenant_membership',
      });

      // 3. user_role_assignments: Tenant Alpha tenant_id + Tenant Beta role_id -> 23503
      await expect(
        migratorPool.query(
          `INSERT INTO public.user_role_assignments (tenant_id, membership_id, role_id)
           VALUES ($1, $2, $3)`,
          [tenantAlpha.id, memberAlphaAdmin.id, roleBetaAdmin.id],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_ura_tenant_role',
      });

      // 4. user_role_assignments: Tenant Alpha + assigned_by_membership_id from Tenant Beta -> 23503
      await expect(
        migratorPool.query(
          `INSERT INTO public.user_role_assignments (tenant_id, membership_id, role_id, assigned_by_membership_id)
           VALUES ($1, $2, $3, $4)`,
          [tenantAlpha.id, memberSharedInAlpha.id, roleAlphaAdmin.id, memberBetaAdmin.id],
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'fk_ura_assigned_by_membership',
      });

      // 5. Verify PostgreSQL 18 column-specific ON DELETE SET NULL (assigned_by_membership_id)
      // Deleting memberAlphaSecondary nulls assigned_by_membership_id on memberAlphaAdmin's assignment without nulling tenant_id!
      await migratorPool.query(`DELETE FROM public.tenant_memberships WHERE id = $1`, [
        memberAlphaSecondary.id,
      ]);
      const preservedAssignment = await migratorPool.query<{
        tenant_id: string;
        assigned_by_membership_id: string | null;
      }>(
        `SELECT tenant_id, assigned_by_membership_id
         FROM public.user_role_assignments
         WHERE tenant_id = $1 AND membership_id = $2`,
        [tenantAlpha.id, memberAlphaAdmin.id],
      );
      expect(preservedAssignment.rows[0]).toEqual({
        tenant_id: tenantAlpha.id,
        assigned_by_membership_id: null,
      });
    } finally {
      await migratorPool.end();
    }
  });

  it('clears transaction-scoped tenant context on rollback and prevents leakage across single-connection pool reuse', async () => {
    const singleConnPool = new Pool({
      connectionString: config.database.appUrl,
      min: 1,
      max: 1,
    });
    const isolatedPoolService = {
      connectClient: () => singleConnPool.connect(),
      queryUnscoped: <R extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
        singleConnPool.query<R>(sql, params),
    } as unknown as DatabasePoolService;
    const isolatedTxManager = new TenantTransactionManager(isolatedPoolService);

    try {
      // 1. Commit in Tenant Alpha and capture backend PID
      const commitPid = await isolatedTxManager.withVerifiedMemberTransaction(
        { tenantId: tenantAlpha.id, actorUserId: userAlphaAdmin.id, correlationId: CORR_ID },
        async (tx) => {
          const res = await tx.query<{ pid: number; count: string }>(
            `SELECT pg_backend_pid() AS pid, COUNT(*)::text AS count FROM public.roles`,
          );
          expect(Number(res.rows[0].count)).toBeGreaterThanOrEqual(1);
          return res.rows[0].pid;
        },
      );

      // 2. Force ROLLBACK inside Tenant Alpha after inserting a temporary role
      await expect(
        isolatedTxManager.withVerifiedMemberTransaction(
          { tenantId: tenantAlpha.id, actorUserId: userAlphaAdmin.id, correlationId: CORR_ID },
          async (tx) => {
            await rbacRepo.createRole(tx, {
              tenantId: tenantAlpha.id,
              slug: 'rolled_back_role',
              name: 'Should Not Persist',
            });
            throw new Error('SIMULATED_PHASE2_ROLLBACK');
          },
        ),
      ).rejects.toThrow('SIMULATED_PHASE2_ROLLBACK');

      // Confirm rolled_back_role did NOT persist
      await isolatedTxManager.withVerifiedMemberTransaction(
        { tenantId: tenantAlpha.id, actorUserId: userAlphaAdmin.id, correlationId: CORR_ID },
        async (tx) => {
          const roles = await rbacRepo.listRoles(tx, tenantAlpha.id);
          expect(roles.some((r) => r.slug === 'rolled_back_role')).toBe(false);
        },
      );

      // 3. Simulate rogue session-level SET on the exact same single pooled connection, then run Tenant Beta tx
      const rawClient = await singleConnPool.connect();
      await rawClient.query(`SET app.current_tenant_id = '${tenantAlpha.id}'`);
      rawClient.release();

      const betaPid = await isolatedTxManager.withVerifiedMemberTransaction(
        { tenantId: tenantBeta.id, actorUserId: userBetaAdmin.id, correlationId: CORR_ID },
        async (tx) => {
          const res = await tx.query<{ pid: number; slug: string }>(
            `SELECT pg_backend_pid() AS pid, slug::text AS slug FROM public.tenants`,
          );
          expect(res.rows).toEqual([{ pid: commitPid, slug: 'tenant-beta-p2' }]);
          return res.rows[0].pid;
        },
      );
      expect(betaPid).toBe(commitPid);

      // 4. Subsequent unscoped reuse on the exact same backend PID exposes ZERO previous tenant context or rows
      const reusedUnscoped = await singleConnPool.query<{
        pid: number;
        tid: string | null;
        uid: string | null;
        super_flag: boolean;
        tenants_cnt: string;
        members_cnt: string;
        roles_cnt: string;
      }>(
        `SELECT
           pg_backend_pid() AS pid,
           public.app_current_tenant_id()::text AS tid,
           public.app_current_user_id()::text AS uid,
           public.app_is_super_admin() AS super_flag,
           (SELECT COUNT(*)::text FROM public.tenants) AS tenants_cnt,
           (SELECT COUNT(*)::text FROM public.tenant_memberships) AS members_cnt,
           (SELECT COUNT(*)::text FROM public.roles) AS roles_cnt`,
      );

      expect(reusedUnscoped.rows[0]).toEqual({
        pid: commitPid,
        tid: null,
        uid: null,
        super_flag: false,
        tenants_cnt: '0',
        members_cnt: '0',
        roles_cnt: '0',
      });
    } finally {
      await singleConnPool.end();
    }
  });
});
