# Technical Risks, External Dependencies & Infrastructure Cost Estimates

**Last Updated:** 2026-11-12  
**Status:** Phase 0 Risk & Budget Assessment  
**Version:** 0.1.0

---

## 1. Technical Risk Register & Mitigations

| Risk ID | Risk Description | Severity | Likelihood | Concrete Mitigation Strategy |
|---|---|---|---|---|
| **RSK-01** | **Cross-Tenant Data Leakage via Connection Pool or Missing Predicate** | Critical | Medium (without guardrails) | Mandatory `TenantTransactionManager` using transaction-local `set_config('app.current_tenant_id', $1, true)` + PostgreSQL `FORCE ROW LEVEL SECURITY` + `NOBYPASSRLS` DB role + CI check failing any `tenant_id` table lacking RLS. |
| **RSK-02** | **SQL Maintenance & Boilerplate Overhead Without an ORM** | Medium | High | Build clean, typed `BaseTenantRepository` query helpers (pagination, dynamic safe sort allowlists, transactional batch `UNNEST` inserts) while keeping SQL 100% explicit and parameterized. |
| **RSK-03** | **Local Dev Environment Drift (Node v26 vs LTS; Host PG 18 Port Conflict)** | Medium | High | Audit found Node `v26.13.0` and Windows `postgresql-x64-18` occupying port `5432`. Pin Node LTS via `.nvmrc`/`engines` in Phase 1, run Docker Desktop daemon, and map Docker PG to `5433` (configurable in `.env`). |
| **RSK-04** | **Scope Creep Across 32 Enterprise Modules with a 3-Person Team** | High | High | Enforce strict wave boundaries; complete Phases 1–9 Foundation before Wave 1 CRM; prohibit starting downstream modules before upstream dependencies reach `QA APPROVED`. |
| **RSK-05** | **Noisy-Neighbor Performance Degradation (Bulk DBMS Imports / Email Blasts)** | High | Medium | Separate API process from BullMQ Worker process; implement per-tenant rate limits and fair-share job concurrency per `tenant_id`; partition large DBMS/CDR/Audit tables; enforce `statement_timeout`. |
| **RSK-06** | **Email Deliverability & IP Reputation Damage (Module 13)** | High | Medium | Isolate transactional auth/system emails (dedicated subdomain + IP/provider) from tenant marketing blasts; require SPF/DKIM/DMARC domain verification per tenant before enabling Module 13. |
| **RSK-07** | **Telephony / Call Recording Storage Growth & PII Exposure (M18–M21)** | High | Medium | Stream recordings to S3 with lifecycle tiering (Standard -> Infrequent Access -> Glacier/Archive per tenant retention policy); serve exclusively via short-lived pre-signed URLs with audit logging. |
| **RSK-08** | **AI Hallucination or Unauthorized Data Access in Jarvis AI (M29)** | High | Medium | Jarvis AI tools must execute strictly inside the requesting user's `VerifiedTenantContext` + RBAC permissions + RLS transaction; never grant AI raw cross-tenant SQL access. |

---

## 2. External Service Dependencies (Phased Adoption)

Not needed until their respective phases/waves—keeping early fixed costs near zero:

| Phase / Wave | Dependency Category | Recommended Options (Pluggable Adapter Pattern) |
|---|---|---|
| **Phase 1–6** | Local Object Storage & Email Testing | **MinIO / RustFS** + **Mailpit** inside Docker Compose (\$0 cost) |
| **Phase 3–4 (Cloud)** | Transactional Email (Auth, Invites) | AWS SES, Postmark, or Resend |
| **Phase 7** | Subscription Billing Gateway | Stripe Billing or Razorpay Subscriptions (India + Global support) |
| **Wave 2 (M13)** | High-Volume Email Blasting | AWS SES (Dedicated IP pool) or SendGrid Marketing / Postal |
| **Wave 3 (M18–M19)** | VoIP / Cloud Dialer / SIP | Twilio Voice, Plivo, Exotel, or Telnyx (adapter interface per tenant) |
| **Wave 4–5 (M21, M29)** | Speech-to-Text & LLM Intelligence | Deepgram / Whisper + Gemini API / Vertex AI (metered against tenant plan quotas) |

---

## 3. Infrastructure Cost Estimates (USD / Month)

Estimates assume cloud deployment (e.g., AWS / GCP / DigitalOcean / Hetzner Cloud + Managed DB/S3) across growth stages, **excluding** pass-through telecom minutes and AI token usage (which should be metered and billed back via Module 06 Subscription & Billing):

| Component | Dev / QA (Phase 1–6) | Staging + Early Prod (10–25 Tenants) | Growth Production (100–250 Tenants) | Enterprise Scale (1,000+ Tenants) |
|---|---|---|---|---|
| **Compute (Next.js + NestJS API + Workers)** | \$0 – \$25 (Local Docker + GitHub Actions free/team tier) | \$60 – \$120 (2x small HA containers/VMs) | \$250 – \$500 (Auto-scaled API + dedicated BullMQ workers) | \$1,200 – \$2,500+ |
| **Managed PostgreSQL 18 (Automated Backups + PITR)** | \$0 (Docker) | \$50 – \$95 (Primary + daily encrypted snapshots + PITR) | \$220 – \$450 (HA Primary + Standby + Read Replica) | \$900 – \$2,000+ |
| **Managed Redis (Cache + BullMQ)** | \$0 (Docker) | \$15 – \$30 | \$60 – \$120 (HA Redis with persistence for BullMQ) | \$250 – \$500 |
| **S3-Compatible Object Storage & Backups** | \$0 (MinIO local) | \$5 – \$15 (Cloudflare R2 / AWS S3, 100–300 GB) | \$40 – \$120 (1–4 TB recordings/exports/backups) | \$300 – \$1,000+ |
| **Transactional Email, DNS, WAF & Monitoring** | \$0 – \$5 (Domain) | \$20 – \$40 (Cloudflare Pro/WAF, SES, Sentry/Grafana) | \$80 – \$180 | \$300 – \$700 |
| **Estimated Monthly Total** | **\$0 – \$30 / mo** | **\$150 – \$300 / mo** | **\$650 – \$1,370 / mo** | **\$2,950 – \$6,700+ / mo** |

> **Cost Optimization Note:** Separating call recordings and bulk exports onto zero-egress S3-compatible storage (such as Cloudflare R2) can reduce Wave 3+ QA audio streaming bandwidth costs by 60–80% compared to standard cloud egress rates.

