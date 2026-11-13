# Local Development Environment Setup Guide

**Last Updated:** 2026-11-13  
**Applies To:** All Developers & Platform Operators (Tushar, Nakshatra, Mansi)  
**Version:** 0.3.1

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
   - **Single Command (Recommended):** Starts both `@ft360/api` (`:4000`) and `@ft360/web` (`:3000`) concurrently:
     ```powershell
     npm run dev
     ```
   - **Separate Terminals (Optional):**
     - Terminal 1 (NestJS API + Swagger): `npm run dev:api`
       - Health Readiness JSON: `http://localhost:4000/api/v1/health`
       - Public Branding JSON: `http://localhost:4000/api/v1/public/branding`
       - Swagger OpenAPI UI: `http://localhost:4000/api/docs`
     - Terminal 2 (Next.js Web UI): `npm run dev:web`
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

---

## 5. Transactional Authentication Email Provider & Durable Outbox Configuration

Authentication verification and password-reset emails are persisted first in PostgreSQL (`public.auth_email_outbox` with HKDF `AES-256-GCM` sealed tokens, `encrypted_action_token` excluded from `ft360_app` `SELECT` grants) before dispatching secret-free `{ outboxId, correlationId }` jobs onto BullMQ (`auth-transactional-mail`). If Redis/BullMQ is temporarily unavailable, `AuthMailOutboxService.drainDueOutboxBatch()` sweeps due rows directly from PostgreSQL with bounded exponential backoff (`AUTH_MAIL_BASE_BACKOFF_SECONDS` .. `AUTH_MAIL_MAX_BACKOFF_SECONDS`, up to `AUTH_MAIL_MAX_ATTEMPTS`).

### Supported `AUTH_MAIL_PROVIDER` Modes
| `AUTH_MAIL_PROVIDER` | Permitted `NODE_ENV` | Required Environment Variables | Behavior |
|---|---|---|---|
| `disabled` *(default)* | Any | `AUTH_OUTBOX_ENCRYPTION_SECRET` (`>=32` chars in `production`) | Never claims `delivered: true`; retains sealed rows in `auth_email_outbox` (`MAIL_PROVIDER_NOT_CONFIGURED`) until a real provider is configured. |
| `sandbox` | **`development` / `test` ONLY** *(startup throws in `staging`/`preview`/`production`)* | `AUTH_MAIL_PROVIDER=sandbox` | Accepts envelopes in memory for local/CI verification without external network calls and without logging raw tokens or complete action URLs. |
| `smtp` | Any | `AUTH_MAIL_SMTP_HOST`, `AUTH_MAIL_SMTP_PORT`, `AUTH_MAIL_SMTP_SECURE`, `AUTH_MAIL_SMTP_REQUIRE_TLS`, `AUTH_MAIL_SMTP_USER`, `AUTH_MAIL_SMTP_PASSWORD`, `AUTH_MAIL_FROM_EMAIL`, `AUTH_MAIL_FROM_NAME`, `AUTH_OUTBOX_ENCRYPTION_SECRET` | Native RFC 5321 TCP/TLS + `STARTTLS` + `AUTH PLAIN` transport; records upstream `provider_message_id` and wipes `encrypted_action_token` upon `250` acceptance. |
| `webhook` | Any | `AUTH_MAIL_WEBHOOK_URL` (**must be `https://` in `production`**), `AUTH_MAIL_WEBHOOK_BEARER_TOKEN`, `AUTH_MAIL_FROM_EMAIL`, `AUTH_MAIL_FROM_NAME`, `AUTH_OUTBOX_ENCRYPTION_SECRET` | Dispatches JSON payload with `X-Idempotency-Key` + `X-Correlation-Id` headers; retries `408`/`429`/`5xx` with bounded exponential backoff. |

### Local/E2E Outbox Preview Safety (`AUTH_DEV_OUTBOX_ENABLED`)
- Defaults to **`false`**.
- Startup aborts immediately if `AUTH_DEV_OUTBOX_ENABLED=true` when `NODE_ENV` is anything other than `development` or `test` (`staging`, `preview`, `production` all fail closed).
- Even when enabled locally, `GET /api/v1/auth/dev-outbox` enforces loopback client IP verification (`127.0.0.1` / `::1`) and returns `404` otherwise.

---

## 6. Controlled One-Time Platform Super Admin Bootstrap Procedure

Normal NestJS application startup (`onApplicationBootstrap`) **never** creates, promotes, activates, marks email-verified, or overwrites the password of any database user — even if `BOOTSTRAP_SUPER_ADMIN_*` variables remain set in the environment.

To provision the **first** Platform Super Admin on a brand-new environment (`0` active Super Admins in `public.users`):

1. Temporarily supply bootstrap secrets for the one-time CLI invocation:
   ```powershell
   $env:BOOTSTRAP_SUPER_ADMIN_EMAIL = "ops-root@your-domain.example"
   $env:BOOTSTRAP_SUPER_ADMIN_PASSWORD = "<StrongUniquePassword12+Chars!>"
   $env:BOOTSTRAP_SUPER_ADMIN_FULL_NAME = "Platform Super Administrator"
   npm run auth:bootstrap-super-admin
   ```
2. Inside PostgreSQL (`fn_auth_bootstrap_initial_super_admin` under advisory lock `360003`), provisioning is **refused (`409`)** and audited (`AUTH_SUPER_ADMIN_BOOTSTRAP_REFUSED`) if:
   - Any `ACTIVE` Platform Super Admin already exists (`SUPER_ADMIN_ALREADY_PROVISIONED`), **or**
   - `BOOTSTRAP_SUPER_ADMIN_EMAIL` already belongs to any existing user account (`BOOTSTRAP_EMAIL_CONFLICT`).
3. **Mandatory Post-Bootstrap Step:** Immediately remove `BOOTSTRAP_SUPER_ADMIN_EMAIL`, `BOOTSTRAP_SUPER_ADMIN_PASSWORD`, and `BOOTSTRAP_SUPER_ADMIN_FULL_NAME` from the shell, `.env`, CI/CD variables, and container secret definitions:
   ```powershell
   Remove-Item Env:BOOTSTRAP_SUPER_ADMIN_EMAIL, Env:BOOTSTRAP_SUPER_ADMIN_PASSWORD, Env:BOOTSTRAP_SUPER_ADMIN_FULL_NAME -ErrorAction SilentlyContinue
   ```

---

## 7. Production Cookie Configuration Requirements

- When `NODE_ENV=production`:
  - `COOKIE_SECURE` defaults to `true`; setting `COOKIE_SECURE=false` aborts application startup immediately.
  - `AUTH_JWT_SECRET` (`>=32` chars) and `AUTH_OUTBOX_ENCRYPTION_SECRET` (`>=32` chars) are mandatory at startup.
  - `COOKIE_DOMAIN` (optional) is strictly validated: schemes (`https://`), ports (`:443`), paths (`/`), IP literals (`127.0.0.1`, `::1`), `localhost`, and single-label TLDs (`com`, `.com`) are rejected at startup.
  - `ft360_at` (`HttpOnly; Secure; SameSite=Lax; Path=/`), `ft360_rt` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`), and `ft360_csrf` (`Secure; SameSite=Lax; Path=/`) preserve strict transport and path isolation.
