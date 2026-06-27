# 0084 — Donation Coding Form import: staging table + rollout runbook

One-time import + reconciliation of the Wildflower "Donation Revenue Coding
Form" exports (FY24 / FY25 / FY26 Google Form responses) plus the Girasol /
Act-60 donations sheet into the CRM.

**Guiding rule — compare, don't clobber.** The apply step only ever *fills a
missing* CRM value or records a reviewer-approved overwrite of a conflict. It
never silently overwrites existing CRM data, and attributes with no schema home
are surfaced in a "needs a decision" list rather than dropped.

## What ships how

| Piece | How it reaches prod |
| --- | --- |
| `coding_form_row_status` enum + `coding_form_rows` table + indexes | Normal **Publish** (drizzle schema diff). `0084_coding_form_rows_staging.sql` is the self-contained, idempotent equivalent — safe to run before or after Publish. |
| The ~288 parsed rows | **Operator step** — run the `import:coding-forms` seed script (parses the source spreadsheets; SQL cannot). |
| Donor/opportunity/gift matches, cross-check resolutions, applied values | **In-app**, by an admin, on the *Coding Form Import* review page (`/coding-form-import`). |

## Rollout order

1. **Publish** the app so the schema (enum + table) lands in prod. (Or run the
   SQL file below — it is idempotent either way.)

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0084_coding_form_rows_staging.sql
   ```

2. **Seed the rows.** Place the four source workbooks where the importer expects
   them and run the seed against the target DB. The seed is idempotent
   (deterministic ids `cfr_<source>_<rowIndex>`, upsert of raw/normalized fields
   only) and **never** clobbers reviewer `decisions` or `status`, so it is safe
   to re-run:

   ```bash
   pnpm --filter @workspace/scripts run import:coding-forms
   ```

   Expected counts: fy24 = 51, fy25 = 111, fy26 = 110, girasol = 12.

3. **Review + apply in the app.** An admin opens **Coding Form Import** (admin
   nav). For each row they confirm/override the donor match, review the
   per-attribute cross-check (new / same / conflict), tick the attributes to
   apply, and click *Apply selected*. Apply is idempotent — re-applying a row
   re-points to the same task/address/allocation it already created.

## Idempotency & safety

- The SQL file is purely additive (enum guard + `IF NOT EXISTS` everywhere) and
  drops nothing.
- The seed refreshes only raw/normalized capture fields; it preserves match
  confirmations, reviewer decisions, and applied state.
- Apply only writes attributes the reviewer explicitly set to `apply`; `same`
  and blocked attributes are left untouched. Re-running apply on an
  already-applied row is a no-op (idempotent via the stored `applied_*` ids).

## Out of scope (captured, not fetched)

- The grant-agreement Google **Drive link** is stored verbatim in
  `coding_form_rows.drive_link` for a downstream PDF-ingestion task; this import
  does not fetch the PDF.
- Stripe/Donorbox PII and auto-creating opportunities/gifts are intentionally
  excluded — unmatched rows stay flagged for a human.
