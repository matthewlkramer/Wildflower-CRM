# 0089 — `settlement_links` Plane-1 settlement table (RUNBOOK)

Plane 1 of the ratified reconciliation redesign (docs/reconciliation-design.md
§4.3). Introduces a first-class, purpose-built link between a Stripe **payout** and
the QuickBooks **deposit** lump it landed as, plus a mirror backfill from today's
`stripe_payouts.qb_reconciliation_status`.

This is the **additive dual-write** phase. The reconcile / confirm / revert +
mint/link choke points already write `settlement_links` alongside
`qb_reconciliation_status` + the pointer columns; **reads are not flipped yet**. The
read-flip (deriving the payout's `settled | proposed | orphan` status off this
table and retiring the 7-value enum) is a separate, later step gated on the
`parity:settlement-links` check passing on **prod**.

## Ratified mapping

`confirmed_excluded` → a **CONFIRMED** settlement link (note `legacy
confirmed_excluded`). Rationale: the payout-level `confirmed_excluded` is a
*settlement* status ("payout↔deposit tie WAS confirmed; the coarse QB lump was
suppressed via `processor_payout` so the per-charge Stripe gifts aren't
double-counted"). It is **not** a non-gift QB exclusion — membership / reimbursement
/ service-revenue live on `staged_payments.exclusion_reason` (Plane 2) and are
untouched by this migration. The "don't double-count across the boundary" part is
the §4.3 supersede rule, folded in Phase 5.

Full mapping:

| `qb_reconciliation_status` | lifecycle | provenance | deposit | note |
| --- | --- | --- | --- | --- |
| `unmatched` | — (no row) | — | — | — |
| `proposed` | `proposed` | `system` | `proposed_qb_staged_payment_id` | — |
| `conflict_approved` | `proposed` | `system` | `COALESCE(qb_conflict, proposed)` | `legacy conflict_approved` |
| `confirmed_reconciled` | `confirmed` | `human`* | `COALESCE(matched, qb_conflict, proposed)` | — |
| `confirmed_keep` | `confirmed` | `human`* | `COALESCE(matched, qb_conflict, proposed)` | `legacy confirmed_keep` |
| `confirmed_replace` | `confirmed` | `human`* | `COALESCE(matched, qb_conflict, proposed)` | `legacy confirmed_replace` |
| `confirmed_excluded` | `confirmed` | `human`* | `COALESCE(matched, qb_conflict, proposed)` | `legacy confirmed_excluded` |

\* `human` when `qb_reconciliation_confirmed_by_user_id` is set (with
`confirmed_by/at` copied over), else `system_confirmed`. Any payout whose resolved
deposit pointer is NULL or dangling is **skipped** (no row) — it honestly derives as
`orphan` rather than forging a tie.

## What ships where

- **Schema** (`settlement_links`, indexes, the two enums) reaches prod through the
  normal **Publish** (drizzle) diff.
- **This file** is the idempotent, self-contained equivalent (mirrors 0088) — it
  creates the same enums/table/indexes AND performs the one-time DATA backfill
  (step 3) that Publish will not do.

## Ordering

1. **Publish** the code/schema first (invariant #7 — Publish diffs the dev DB; this
   ships the table and the dual-write route code).
2. Then run this file against prod to perform the backfill (and to be a no-op on the
   already-Published table).

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0089_settlement_links.sql
```

Expect a NOTICE like:

```
NOTICE:  0089: settlement_links=<N> (proposed=<a>, confirmed=<b>, exempt=<c>) backfilled from qb_reconciliation_status
```

## Idempotency / safety

- Re-running is a no-op: enum guards swallow `duplicate_object`; table/indexes are
  `IF NOT EXISTS`; the backfill INSERT is `ON CONFLICT (id) DO NOTHING` on the
  deterministic `sl_<payout_id>` id + `UNIQUE(payout_id)`.
- Nothing is dropped. `qb_reconciliation_status` + the pointer columns are left
  untouched — they remain the dual-write source of truth until a later drop phase.

## Verify (read-only)

```sql
-- Every non-unmatched payout with a resolvable deposit has a settlement link.
SELECT p.qb_reconciliation_status, COUNT(*) AS payouts,
       COUNT(sl.id) AS linked
FROM stripe_payouts p
LEFT JOIN settlement_links sl ON sl.id = 'sl_' || p.id
GROUP BY p.qb_reconciliation_status
ORDER BY p.qb_reconciliation_status;

-- Exclusivity holds (should return zero rows).
SELECT payout_id, COUNT(*)
FROM settlement_links
GROUP BY payout_id
HAVING COUNT(*) > 1;

-- Non-exempt links always carry a deposit (should return zero rows).
SELECT id, lifecycle
FROM settlement_links
WHERE lifecycle <> 'exempt' AND deposit_staged_payment_id IS NULL;
```

The full machine-checked gate is:

```bash
# NOTE: the script connects to $DATABASE_URL, which in the workspace shell is the
# DEV database. To run the gate against PROD, override it for this one command.
# The gate is READ-ONLY (SELECT/count only — it never writes), so this is safe.
DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/api-server run parity:settlement-links
```

It must exit `PASS` on **prod** before the read-flip phase begins. Optional
`--out <path>` writes a machine-readable report.
