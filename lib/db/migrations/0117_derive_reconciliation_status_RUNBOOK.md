# Runbook — 0117 Derive reconciliation status (drop stored status machinery)

## What this does

`staged_payments` and `stripe_staged_charges` no longer carry a **stored**
lifecycle status — status is derived at read time from facts
(`artifacts/api-server/src/lib/derivedStatus.ts`), emitted as
`pending | match_proposed | match_confirmed | excluded`. "Rejected" is removed
from the model entirely (reject endpoints and the rejected queue are gone).
This file physically drops the now-dead stored machinery:

| Dropped | Was |
| --- | --- |
| `staged_payments.status` (+ index) | stored lifecycle (`pending/approved/rejected/excluded/reconciled`) |
| `staged_payments.rejected_at` / `rejected_by_user_id` | reject audit stamp |
| `stripe_staged_charges.status` (+ index) | stored lifecycle (same enum) |
| `stripe_staged_charges.rejected_at` / `rejected_by_user_id` | reject audit stamp |
| `stripe_staged_charges.dismissed_qb_staged_payment_ids` | per-charge QB-tie dismissal array (charge-tie reject now just clears the proposed pointer) |
| `stripe_payouts.qb_supersede_status` (+ index) | retired auto-supersede audit column |
| `reconciliation_proposals` (whole table) | proposals store (route + UI removed) |
| `financial_correction_dismissals` (whole table) | dismiss store (endpoint + button removed) |

**Not dropped:** the `staged_payment_status` pg enum **type**
(`donorbox_donations.status` still uses it — Donorbox keeps its stored column,
mapped to the new vocabulary at the API edge); `match_status`, `match_score`,
`match_confirmed_at`, and the three gift-link columns (they are the FACTS the
derivation reads); `duplicate_dismissals`, `unit_groups`, `settlement_links`,
bundle drafts, and `stripe_payouts.status`.

## The one-time backfill (runs inside the same transaction)

Before dropping `status`, the file maps every row a human already
dispositioned out of the queue — `status IN ('rejected','excluded')` with a
NULL `exclusion_reason` — to `exclusion_reason = 'other'`. Without this, a
legacy rejected row (no gift link, no exclusion reason) would re-derive as
`pending` and silently re-enter the live work queue. Watch for the two
`NOTICE` lines with the mapped row counts (dev currently has 3 such
staged-payment rows, all `Zztest` e2e seeds; charges have 0).

## Why it is safe

- **Status was already redundant.** Every read in the new build derives status
  from facts; nothing reads or writes the dropped columns. Rows whose stored
  status disagreed with their facts were exactly the stale-status bugs this
  redesign removes.
- **Guarded intent preservation.** The backfill keeps human "rejected"
  dispositions out of the pending queue (excluded/`other`), and it runs in the
  SAME `psql -1` transaction as the drops — an abort leaves everything intact.
- **Money-total-neutral.** No gift, allocation, ledger, or settlement row is
  touched. Only disposition metadata is dropped.

## Pre-apply census (read-only, run on prod BEFORE applying)

Legacy rows stored as `approved`/`reconciled` whose FACTS don't evidence a
booking (no gift link, no confirmed settlement link, no counted ledger row)
will re-derive as `pending` and re-enter the work queue — intended (those are
exactly the stale-status rows the redesign surfaces), but run this first so
the queue-size jump is expected, not alarming:

```sql
-- Stored-resolved staged payments with NO booking facts (will re-derive pending):
SELECT count(*) FROM staged_payments sp
WHERE sp.status IN ('approved','reconciled')
  AND sp.exclusion_reason IS NULL
  AND sp.matched_gift_id IS NULL AND sp.created_gift_id IS NULL
  AND sp.group_reconciled_gift_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM settlement_links sl
                  WHERE sl.deposit_staged_payment_id = sp.id
                    AND sl.lifecycle = 'confirmed')
  AND NOT EXISTS (SELECT 1 FROM payment_applications pa
                  WHERE pa.payment_id = sp.id AND pa.link_role = 'counted');

-- Same census for Stripe charges (facts = gift links only):
SELECT count(*) FROM stripe_staged_charges c
WHERE c.status IN ('approved','reconciled')
  AND c.exclusion_reason IS NULL
  AND c.matched_gift_id IS NULL AND c.created_gift_id IS NULL;

-- Rows the backfill will map to excluded/'other' (compare with apply NOTICEs):
SELECT count(*) FROM staged_payments
WHERE status IN ('rejected','excluded') AND exclusion_reason IS NULL;
SELECT count(*) FROM stripe_staged_charges
WHERE status IN ('rejected','excluded') AND exclusion_reason IS NULL;
```

## Deploy ordering (prod) — **Publish FIRST, then this SQL on prod, then dev, back-to-back**

The currently-deployed prod build still **writes** these columns (approve /
exclude / reject set `status`). Dropping them before the new code deploys
would 500 live writes. So:

1. **Publish this task's code first.** At this point BOTH dev and prod still
   hold the columns, so the Publish dev↔prod diff is clean (this release is
   drop-only — there are no additive schema changes). The new build deploys
   and stops touching the dropped machinery.
2. **After the new code is live in prod**, apply this file to **prod**:
   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0117_derive_reconciliation_status.sql
   ```
   Watch for the two backfill `NOTICE` counts.
3. Apply the SAME file to **dev**:
   ```bash
   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0117_derive_reconciliation_status.sql
   ```
4. Restart the dev API server workflow afterward (it runs a built bundle).

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT`
inside it.

Run steps 2 and 3 **back-to-back and do NOT Publish between them.** In the
window where prod has dropped the columns but dev still holds them, a Publish
would see dev-only columns and propose an ADDITIVE re-create of the dead
machinery on prod.

### ⚠️ Do NOT drop dev alone before Publish

If dev drops the columns while prod still has them, the next Publish sees
prod-only columns and proposes a **destructive prod drop**, which aborts the
whole diff. Keep dev and prod in lockstep **through** Publish; only after
Publish drop **both**.

### Note on the post-merge push

When this task merges, `post-merge.sh` runs interactive `drizzle-kit push`
against the **dev** DB. The schema removed these columns/tables but the dev DB
still holds them, so push detects data-loss DROPs and **aborts** — expected
and harmless for this merge (the release is drop-only; there are no additive
changes to lose; the dev app keeps serving with the columns as dead orphans —
`status` and `qb_supersede_status` both have defaults, so inserts from the new
code succeed). Once step 3 above has run, dev matches the schema again and
post-merge push returns to a clean no-op.

## Idempotency

The backfill `DO` block short-circuits with a NOTICE once the `status` columns
are gone; every drop uses `IF EXISTS`. A second run is a no-op.

## Verify (read-only, after applying)

```sql
-- Columns gone (expect 0 rows):
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name IN ('staged_payments','stripe_staged_charges')
       AND column_name IN ('status','rejected_at','rejected_by_user_id',
                           'dismissed_qb_staged_payment_ids'))
   OR (table_name = 'stripe_payouts' AND column_name = 'qb_supersede_status');

-- Tables gone (expect NULL, NULL):
SELECT to_regclass('public.reconciliation_proposals'),
       to_regclass('public.financial_correction_dismissals');

-- The enum type survives for Donorbox (expect 1 row):
SELECT typname FROM pg_type WHERE typname = 'staged_payment_status';

-- Formerly-rejected rows live in the excluded lane (compare with the NOTICE
-- counts printed during apply):
SELECT count(*) FROM staged_payments WHERE exclusion_reason = 'other';
SELECT count(*) FROM stripe_staged_charges WHERE exclusion_reason = 'other';
```

## Rollback

Structure-only if ever needed: re-add the columns/tables from the pre-drop
DDL. There is nothing to restore into them — status is fully derived from
facts, and the backfill preserved every human disposition as
`exclusion_reason = 'other'`. Treat rollback as schema shape, not data
recovery.
