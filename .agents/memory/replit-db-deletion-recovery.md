---
name: Replit DB deletion nukes dev AND prod
description: Deleting the built-in Replit database deletes both the dev and production databases; recovery paths and verification pitfalls.
---

Deleting the built-in Replit PostgreSQL resource deletes BOTH the development and
production databases (they are branches of one Neon project). A subsequent Publish
recreates the prod schema (empty tables) from the dev DB diff, which makes prod look
"structurally fine" while serving zero rows.

**Why:** Happened 2026-07-11 — user deleted the database trying to unstick a hung
publish; live prod CRM went blank even though a publish "succeeded" right after.

**How to apply:**
- If prod suddenly has all tables but zero rows right after a DB deletion + publish,
  assume the Neon project was recycled — don't debug application code.
- Recovery: dev comes back via Replit checkpoint rollback (checkpoints include the
  dev DB). Prod needs a human-run `psql "$PROD_DATABASE_URL"` restore of a pg_dump
  file: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then `-f dump.sql`
  (never agent-run; prod is human-applied by policy). Re-run any post-dump
  migration files (e.g. index-only ones) afterward since DROP SCHEMA removes them.
- Identify a dump's source DB by fingerprints, not filename: QBO staged_payments
  volume (prod-scale ~3k vs partial dev), audit_log volume/recency, and users count
  (dev is polluted with e2e test users).
- After any bulk restore, `pg_stat_user_tables.n_live_tup` is stale (can read 0 or
  tiny on fully-loaded tables) until ANALYZE — always verify with `count(*)`.
