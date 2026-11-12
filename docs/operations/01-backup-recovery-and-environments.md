# Backup, Disaster Recovery & Environment Operations

**Last Updated:** 2026-11-12  
**Status:** Phase 0 Operations Specification  
**Version:** 0.1.0

---

## 1. Environment Topology

| Environment | Git Branch | Purpose | Data Policy |
|---|---|---|---|
| **Local Development** | `feature/*`, `bugfix/*` | Developer workstation via Docker Compose | Synthetic seed data only; never real customer PII |
| **CI Ephemeral** | Pull Requests | Automated GitHub Actions build, migration, unit, integration, RLS & Playwright suites | Ephemeral containers destroyed after run |
| **Staging** | `development` | Pre-release integration, Functional QA, Security QA, UAT, Restore Drills | Anonymized/synthetic multi-tenant dataset mirroring prod scale |
| **Production** | `main` (Tagged `vX.Y.Z`) | Live customer SaaS workloads | Encrypted at rest & in transit; deployable **only** with explicit approval from Tushar |

---

## 2. Recovery Objectives (RPO & RTO Targets)

| Tier / Subsystem | Target RPO (Max Data Loss) | Target RTO (Max Recovery Time) | Mechanism |
|---|---|---|---|
| **PostgreSQL 18 Primary DB** | **<= 5 minutes** (Point-in-Time Recovery) | **<= 60 minutes** | Continuous WAL archiving to encrypted object storage + automated daily full base backups |
| **S3 Object Storage (Recordings, Attachments)** | **~0 minutes** (Cross-AZ durable) | **<= 30 minutes** | Bucket versioning + Object Lock / soft-delete lifecycle preventing accidental purge |
| **Redis (Cache & Queues)** | Cache: ephemeral; BullMQ: **<= 5 minutes** | **<= 15 minutes** | Redis AOF (`appendfsync everysec`) + RDB snapshots for BullMQ instance |
| **Source Code, SQL Migrations & Docs** | **0** | **<= 15 minutes** | Protected GitHub repository + mirrored offsite git backup |
| **Secrets & Environment Config** | **0** | **<= 15 minutes** | Versioned Cloud Secret Manager + encrypted offline emergency recovery vault (never in Git) |

---

## 3. Comprehensive Backup & Restore Verification Policy

1. **Automated Encrypted Database Backups:**
   - Daily full encrypted (`AES-256`) snapshots retained for **30 days**; weekly snapshots retained for **12 weeks**; monthly compliance archives retained per regulatory policy.
   - Continuous Write-Ahead Log (WAL) shipping enabling Point-in-Time Recovery (PITR) to any second within the 14-day rolling window (protects against accidental operator error).
2. **Mandatory Periodic Restore Drills:**
   - **Untested backups are not backups.** Before Phase 9 Foundation Release—and **monthly** thereafter—an automated/documented restore drill restores a production-equivalent encrypted backup into an isolated verification database, runs `schema_migrations` checksum verification and data integrity queries, and logs a dated Restore Verification Report in `/docs/operations/`.
3. **Strict Secret Hygiene:**
   - Production database URLs, JWT signing keys, S3 credentials, SMTP keys, and customer database dumps must **never** be committed to GitHub, stored in Docker images, or copied onto unencrypted developer machines.

