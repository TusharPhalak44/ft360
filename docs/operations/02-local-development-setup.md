# Local Development Environment Setup Guide

**Last Updated:** 2026-11-12  
**Applies To:** All Developers (Tushar, Nakshatra, Mansi)  
**Version:** 0.1.0

---

## 1. Non-Interference with Host PostgreSQL Services

Many developer workstations run a local Windows PostgreSQL service (commonly on port `5432` or `5433`).
- **Rule:** Never stop, reconfigure, or overwrite an existing host PostgreSQL service.
- Before starting Docker infrastructure, verify which ports are free on your machine:
  ```powershell
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(3000, 4000, 5432, 5433, 5434, 6379) }
  ```
- `.env.example` defaults `POSTGRES_HOST_PORT=5433` (mapped to container port `5432`). If your host Windows PostgreSQL service listens on `5433`, set `POSTGRES_HOST_PORT=5434` (and update port `5434` in `DATABASE_MIGRATOR_URL` and `DATABASE_APP_URL`) in your local `.env` file.

---

## 2. First-Time Workspace Bootstrap

1. **Create Local Environment File:**
   ```powershell
   Copy-Item .env.example .env
   ```
2. **Start Docker Desktop & Boot Infrastructure Containers:**
   ```powershell
   npm run infra:up
   npm run infra:ps
   ```
   Wait until both `ft360-postgres` (`postgres:18-alpine`) and `ft360-redis` (`redis:7-alpine`) report `(healthy)`. On first boot, `docker/postgres/init/01-init-roles.sh` automatically provisions:
   - `ft360_migrator` — schema & table owner used **exclusively** by `npm run db:migrate`.
   - `ft360_app` — restricted runtime application role (`NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`, **never owns tables**).
3. **Install Workspace Dependencies:**
   ```powershell
   npm install
   npm run check:no-orm
   ```
4. **Compile Shared Types & Execute SQL Migrations:**
   ```powershell
   npm run build --workspace=@ft360/shared-types
   npm run db:migrate
   npm run db:migrate:status
   ```
5. **Run Automated Verification Suites:**
   ```powershell
   npm run lint
   npm run typecheck
   npm run test:unit
   npm run test:integration
   ```
6. **Launch Backend & Frontend Services:**
   - Terminal 1 (NestJS API + Swagger):
     ```powershell
     npm run dev:api
     ```
     - Health Readiness JSON: `http://localhost:4000/api/v1/health`
     - Public Branding JSON: `http://localhost:4000/api/v1/public/branding`
     - Swagger OpenAPI UI: `http://localhost:4000/api/docs`
   - Terminal 2 (Next.js Web UI):
     ```powershell
     npm run dev:web
     ```
     - Web Foundation Status UI: `http://localhost:3000`

---

## 3. SQL Migration Authoring Workflow

1. Add paired files in `db/migrations/`:
   - `NNNN_<snake_case_name>.up.sql`
   - `NNNN_<snake_case_name>.down.sql`
2. Every tenant-owned table **must**:
   - Be created via migrations (owned by `ft360_migrator`, **not** `ft360_app`).
   - Include `tenant_id UUID NOT NULL` and composite foreign keys `(tenant_id, ...)`.
   - Enable `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;` and `ALTER TABLE <name> FORCE ROW LEVEL SECURITY;`.
   - Define policies referencing `app_current_tenant_id()`.
   - Grant explicit DML (`SELECT, INSERT, UPDATE, DELETE`) to `ft360_app`.
3. Verify forward and backward idempotency locally before opening a PR:
   ```powershell
   npm run db:migrate
   npm run db:migrate:rollback
   npm run db:migrate
   ```

---

## 4. Troubleshooting Windows Docker Desktop & WSL2 Virtualization

If `docker compose up` or `docker desktop start` fails on Windows with `WslVirtualizationDisabledInFirmware` or `HCS_E_HYPERV_NOT_INSTALLED`:

1. **Enable Hardware Virtualization in BIOS/UEFI:** Reboot into BIOS/UEFI and enable **Intel VT-x / Virtualization Technology** (Intel) or **SVM Mode / AMD-V** (AMD).
2. **Enable Windows Virtual Machine Platform & WSL2:** Run in an elevated (Administrator) PowerShell session:
   ```powershell
   wsl.exe --install --no-distribution
   dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
   dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
   ```
3. **Reboot Windows**, start Docker Desktop, verify `docker info`, and re-run `npm run infra:up`.
