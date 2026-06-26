# 0082 — Allocation restriction & coding cleanup (Task #449)

## What this changes

1. **Restriction taxonomy.** The coarse `formal_*` restriction booleans
   (`gift_allocations.formal_regional_restriction` / `formal_fund_use_restriction`,
   `pledge_allocations.formally_restricted`) and the old `restriction_type` enum
   are replaced by **three independent axes** on both allocation tables —
   `regional_restriction_type` / `usage_restriction_type` / `time_restriction_type`
   — each a `restriction_axis` (`donor_restricted` | `wf_restricted` |
   `unrestricted`), NOT NULL default `unrestricted`.
2. **Coding snapshot moved off allocations onto `staged_payments`.** The derived
   revenue-coding snapshot (object code + override, revenue location + override,
   revenue class + override, coding flags, deferred revenue + reason) describes a
   **QuickBooks payment**, not the donor's intent, so it now lives on
   `staged_payments`. The allocation still **generates a coding preview on demand**
   from its scope (`deriveRevenueCoding`) but no longer persists one.
3. **Conditions moved onto `pledge_allocations`.** Grant conditions move from the
   opportunity **header** (`conditional` / `conditions` / `conditions_met`) down
   onto `pledge_allocations`; the header now exposes a **read-only derived rollup**.
   This file copies the header values down.
4. **Rename `reimbursable_share` → `reimbursement_type`** (the pg enum type and the
   column on both allocation tables; values unchanged: `direct` | `indirect`).

The deprecated columns are kept `@deprecated` in the Drizzle schema so Publish does
not try to drop them. Their physical DROP is the deferred, commented section 4 of
the SQL (run later, by hand, in lockstep with removing the `@deprecated` columns
from the schema).

## Order of operations

> The **rename** (step 4) cannot ship safely through the non-interactive Publish
> diff — drizzle would see it as drop + add and **lose the data**. So this file is
> applied **BEFORE Publish**: it renames in place and creates every new additive
> column/type with `IF NOT EXISTS` guards, so the subsequent Publish diff is a
> no-op for these tables. The file is idempotent and is also safe to run after
> Publish (every CREATE/ADD/RENAME is guarded).

1. **Apply this file to prod first** (before Publish):

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
     -f lib/db/migrations/0082_allocation_restriction_and_coding_cleanup.sql
   ```

   Read the two `NOTICE` lines:
   - the donor-restricted / conditional counts (sanity), and
   - **UN-PROPAGATED formal flags (must be 0)** for both tables.

2. **Publish** the new code (normal flow). The drizzle diff should now be a no-op
   for `gift_allocations` / `pledge_allocations` / `staged_payments` (columns and
   the `reimbursement_type` type already match). Confirm the deploy healthcheck is
   green.

## Backfill semantics

- **Restriction axes** (monotonic, guarded on the axis still being `unrestricted`):
  - gift `formal_regional_restriction = true` → `regional_restriction_type =
    donor_restricted`.
  - gift `formal_fund_use_restriction = true` → `usage_restriction_type =
    donor_restricted`.
  - pledge `formally_restricted = true` → `usage_restriction_type =
    donor_restricted` (the single flag can't distinguish axes; regional + time stay
    `unrestricted`).
  - **time** axis: all rows default `unrestricted` (no source signal).
  - **Verify** the CSP/CMO rows reconciled in `0076` all land `donor_restricted`.
- **Conditions header → allocation** (guarded so existing allocation values are
  never clobbered):
  - `conditional` copied where the allocation's is NULL and the header has one.
  - `conditions` (free-text) copied only where the allocation has none (preserves
    per-tranche contingency text).
  - `conditions_met` copied where the allocation still holds the `no` default and
    the header is non-default.
  - Opportunities with no allocations keep the non-conditional default.
- **Coding: re-derive, do NOT copy.** The old allocation coding columns were
  *derived* data, and the new home (`staged_payments`) is keyed to a QuickBooks
  payment — there is no general 1:1 allocation→staged link. The coding preview is
  produced on demand from allocation scope; the reviewer captures it onto the
  staged row in the reconciliation workbench. So there is intentionally **no**
  allocation→staged coding copy.

## Idempotency

Every CREATE TYPE / ADD COLUMN / RENAME is guarded; every backfill UPDATE is guarded
on the target still holding its default. On the **same source state** a re-run is a
no-op. It is a one-time file by intent — do **not** re-run it after an admin manually
edits a restriction axis or condition, or it could re-stamp that intentional edit.

## Deferred cleanup (separate, later, by hand)

Only after the new code is deployed and section 3 reports un-propagated = 0, drop the
deprecated columns (commented section 4 of the SQL) **and** remove the matching
`@deprecated` columns from the Drizzle schema in the same change so dev and prod stay
in lockstep. The opportunity-header `conditional` / `conditions` / `conditions_met`
columns are kept physical for now (the app no longer writes them); drop them only in
a later, separate reviewed change.
