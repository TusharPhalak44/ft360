## Summary

- **Module / Phase:**
- **Owner:** (`Tushar` / `Nakshatra` / `Mansi`)
- **Target Branch:** (`development` for feature work; `main` only via reviewed release merge from `development`)

## Mandatory Architecture & Security Checklist

- [ ] **Zero ORM:** No ORM packages (`prisma`, `typeorm`, `drizzle-orm`, `sequelize`, `knex`, etc.) introduced (`npm run check:no-orm` passes).
- [ ] **Parameterized Native SQL (`pg`):** All SQL queries use explicit `$1, $2` parameters; zero string interpolation of user input.
- [ ] **Multi-Tenant Isolation:** Tenant-owned tables enable + `FORCE ROW LEVEL SECURITY`, execute strictly via `TenantTransactionManager`, and reject untrusted frontend tenant identifiers.
- [ ] **SQL Migrations:** Versioned `.up.sql` and `.down.sql` migrations tested (`migrate -> rollback -> migrate`) with `ft360_migrator` owning DDL and `ft360_app` granted least-privilege DML only.
- [ ] **Permanent Docs Updated:** Updated relevant `/docs/` schema, RLS, task register, and test report files.

## Executed Test Evidence

- [ ] `npm run check:no-orm`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration` (including negative cross-tenant RLS checks)
- [ ] `npm run build`
- [ ] `npm run test:e2e` (if UI/API contracts changed)
