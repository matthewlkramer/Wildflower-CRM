# 0127 — Charge → QuickBooks "Stripe fee" row link + backfill

## What this adds

When a bookkeeper records a charge's GROSS donation as its own QuickBooks
deposit line, the same deposit usually carries a sibling NEGATIVE "Stripe fee"
line (gross + fee = the net that hit the bank). Confirming the donor line's
charge↔QB tie now also auto-claims that fee row onto the charge
(`stripe_staged_charges.linked_fee_qb_staged_payment_id`), so the fee row is
accounted for instead of lingering as apparently-unreconciled money.

Plane-1 settlement EVIDENCE only: fee rows NEVER enter `payment_applications`
and are never summed into any money trail (per
`docs/reconciliation-design.md`).

This file:

1. Adds the column + FK (`ON DELETE SET NULL`) + partial unique index (a fee
   row is evidence for at most one charge). Publish creates these too by
   diffing the dev DB — every DDL statement is guarded, so either order is
   safe, but apply this file AFTER Publish (the backfill needs the app schema
   current anyway).
2. Backfills the link for ALREADY-confirmed charge ties, using byte-for-byte
   the same rule as the app's confirm-time detection (`claimSiblingFeeRows` /
   `pairChargeFeeRows` in `artifacts/api-server/src/lib/chargeQbTie.ts`):
   candidate = NEGATIVE row of the SAME QB deposit, amount exactly
   −(gross − net) to the cent, fee-ish payer/description, not spoken for
   anywhere; equal-fee twins pair rank-to-rank (charges by id × rows by
   qb_line_id, id) so each row is claimed at most once.

## Apply

```
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0127_charge_fee_link_column_and_backfill.sql
```

Apply **after** Publish has shipped the schema/code, and after 0126 (numbered
order; the files are independent).

Idempotent: re-running finds nothing left to do (DDL is guarded; the backfill
only fills NULL links from unclaimed rows).

## Expected statement tags (first run)

Prod dry-run of the exact pairing predicate on 2026-07-14:

| Step | Statement | Expected |
|---|---|---|
| 1 | ALTER TABLE ADD COLUMN / DO $$ FK $$ / CREATE INDEX | `ALTER TABLE`, `DO`, `CREATE INDEX` |
| 2 | Backfill UPDATE | `UPDATE 41` |

Re-run: `UPDATE 0`.

Dry-run context behind the 41: 52 confirmed-tied charges carry a real fee
(gross > net); 51 unclaimed negative fee-ish rows exist across their deposits;
41 pair exactly to the cent within the same deposit ($964.50 of fee lines
claimed). The other ~11 tied charges have no matching sibling row — typically
the bookkeeper netted the fee into the deposit instead of booking a separate
fee line — and correctly stay unlinked.

If the team confirms more charge ties in the workbench between the dry-run and
apply, the app claims those fee rows itself at confirm and the tag comes in
slightly lower — benign drift, not a failure. Judge by the verification query,
not the exact 41.

## Verification

```sql
SELECT count(*) AS fee_linked
FROM stripe_staged_charges
WHERE linked_fee_qb_staged_payment_id IS NOT NULL;
```

Expect ≥ 41 (41 from the backfill + any the app claimed at confirm since).
Spot-check one: the linked staged_payments row is a negative amount equal to
−(charge gross − net), in the same QB deposit (realm_id, qb_entity_type,
qb_entity_id) as the charge's `linked_qb_staged_payment_id` row.

## No revert path (by design)

Confirmed charge↔QB donor ties have no revert path; the fee link mirrors that.
If a link is ever wrong, the fix is a reviewed SQL correction — clearing
`linked_fee_qb_staged_payment_id` on the affected charge is safe (the column
is pure plane-1 evidence; nothing derives money from it).
