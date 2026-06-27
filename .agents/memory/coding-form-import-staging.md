---
name: Coding-form import staging
description: How the one-time Donation Coding Form import + reconciliation is structured (staging table, compare-don't-clobber, idempotent apply).
---

The Donation Revenue Coding Form import (FY24/FY25/FY26 Google-Form exports +
Girasol/Act-60 sheet, ~288 rows) is a one-time, idempotent reconciliation, NOT a
live sync.

**Rule: compare, don't clobber.** Apply only ever fills a *missing* CRM value or
records a reviewer-approved overwrite of a `conflict`. `same` attributes and
attributes with no schema home are never written; no-schema-home attrs surface in
a "needs a decision" list.

**Shape.**
- Staging table `coding_form_rows` (schema `lib/db/src/schema/codingFormRows.ts`)
  holds raw captured values + normalized scalars + proposed/confirmed match
  (plain-text donor ids; Donor XOR enforced in the API at match/apply, NOT a DB
  CHECK, because a row may have ZERO matches) + reviewer `decisions` jsonb +
  applied-state pointers (`applied_task_id` / `applied_address_id` /
  `applied_allocation_id`) that make re-apply idempotent.
- Deterministic ids `cfr_<source>_<rowIndex>` so re-seeding is idempotent; seed
  refreshes only raw/normalized capture fields, never decisions/status.
- Cross-check (new/same/conflict/na) is computed **live on read** in
  `artifacts/api-server/src/lib/codingForms.ts`, never stored, so it can't go stale.
- Apply re-derives via `applyDerivedOppFields` / `applyGiftQbTieMany`.

**Rollout (invariant #7).** Schema (enum + table) ships via Publish; the
self-contained idempotent equivalent is `lib/db/migrations/0084_*.sql` (+ RUNBOOK).
Row SEED is an operator step (`pnpm --filter @workspace/scripts run import:coding-forms`,
needs xlsx + DB access — SQL can't parse spreadsheets). Review/apply is in-app by
an admin at `/coding-form-import`.

**Out of scope:** Drive PDF fetch (link captured only), Stripe/Donorbox PII,
auto-creating opps/gifts (unmatched rows stay flagged for a human).
