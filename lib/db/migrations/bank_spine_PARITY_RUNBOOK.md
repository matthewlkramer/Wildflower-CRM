# Runbook — bank-spine money model PROD parity gates

## What this is

The bank-spine migrations (`0159`–`0166`, applied in order `0159 → 0160 → 0161
→ 0163 → 0162 → 0164 → 0165 → 0166`) build the successor money spine
(docs/adr-bank-spine-money-model.md) **additively** — nothing reads the new
tables yet. Before any read cutover (re-anchoring ledger reads onto
`payment_unit_id`, retiring `settlement_links` / split children / the Donorbox
link overlay — Phase 9), these gates must pass **on PROD**. Dev parity is not
sufficient.

All queries are read-only `SELECT`s. Run each against
`"$PROD_DATABASE_URL"`; the expectation is stated with each gate. Gates marked
*(informational)* produce a worklist/number to review, not a hard zero.

## G1 — Stripe unit coverage (hard: both counts = 0)

Every non-excluded charge has exactly one unit; no unit points at an excluded
charge.

```sql
SELECT count(*) AS missing_units
FROM stripe_staged_charges sc
WHERE sc.exclusion_reason IS NULL
  AND NOT EXISTS (SELECT 1 FROM payment_units pu WHERE pu.stripe_charge_id = sc.id);

SELECT count(*) AS units_on_excluded_charges
FROM payment_units pu
JOIN stripe_staged_charges sc ON sc.id = pu.stripe_charge_id
WHERE sc.exclusion_reason IS NOT NULL;
```

## G2 — Money totals (hard: each diff = 0.00)

Unit totals equal source totals, per lane.

```sql
-- Stripe lane
SELECT COALESCE(SUM(sc.gross_amount), 0) - COALESCE(SUM(pu.gross_amount), 0) AS stripe_gross_diff
FROM stripe_staged_charges sc
LEFT JOIN payment_units pu ON pu.stripe_charge_id = sc.id
WHERE sc.exclusion_reason IS NULL;

-- Check lane: every QB-sourced unit equals its staged row's amount
SELECT count(*) AS check_unit_amount_mismatches
FROM payment_units pu
JOIN staged_payments sp ON sp.id = pu.source_staged_payment_id
WHERE pu.kind <> 'stripe_charge'
  AND pu.gross_amount IS DISTINCT FROM sp.amount;
```

## G3 — No double-unitization (hard: 0 rows)

A QB-sourced unit must never describe money that is also a Stripe unit.

```sql
SELECT pu.id
FROM payment_units pu
JOIN source_links sl ON sl.qb_staged_payment_id = pu.source_staged_payment_id
WHERE pu.kind <> 'stripe_charge'
  AND sl.link_type IN ('charge_qb_tie', 'charge_fee_row');
```

## G4 — Deposit composition (mixed)

```sql
-- hard: no component on a payout-claimed deposit
SELECT count(*) AS components_on_payout_deposits
FROM bank_deposit_components c
JOIN stripe_payouts p ON p.bank_deposit_id = c.bank_deposit_id;

-- informational: overallocated deposits (components exceed the bank amount) —
-- each is a QBO inference error to review
SELECT c.bank_deposit_id, d.amount, SUM(c.amount) AS component_total
FROM bank_deposit_components c
JOIN bank_deposits d ON d.id = c.bank_deposit_id
GROUP BY c.bank_deposit_id, d.amount
HAVING SUM(c.amount) > d.amount;

-- informational: ambiguity + review volumes
SELECT count(*) FILTER (WHERE ambiguous_deposit_match) AS ambiguous,
       count(*) FILTER (WHERE needs_review) AS needs_review,
       count(*) AS total
FROM bank_deposit_components;
```

## G5 — Payout ↔ deposit ties (hard: both counts = 0)

```sql
-- amount must agree exactly on every tie
SELECT count(*) AS payout_deposit_amount_mismatches
FROM stripe_payouts p
JOIN bank_deposits d ON d.id = p.bank_deposit_id
WHERE p.amount IS DISTINCT FROM d.amount;

-- a matched payout must be 'paid'
SELECT count(*) AS nonpaid_matched_payouts
FROM stripe_payouts p
WHERE p.bank_deposit_id IS NOT NULL AND p.status <> 'paid';
```

## G6 — Ledger annotation coverage (hard: first = 0; informational: second)

```sql
-- hard: every stripe-anchored row whose charge has a unit is annotated
SELECT count(*) AS unannotated_stripe_rows
FROM payment_applications pa
JOIN payment_units pu ON pu.stripe_charge_id = pa.stripe_charge_id
WHERE pa.payment_unit_id IS NULL;

-- informational: QB-anchored counted rows with no unit (undeposited payments,
-- non-deposit-composing rows) — these stay on the legacy anchor until a
-- deposit/feed gives them a unit
SELECT count(*) AS qb_counted_rows_without_unit
FROM payment_applications pa
WHERE pa.evidence_source = 'quickbooks'
  AND pa.link_role = 'counted'
  AND pa.payment_unit_id IS NULL;
```

## G7 — Counted consolidation worklist (informational — MUST be reviewed, and
## each group consolidated to ONE counted row, before the counted-unique flips
## to payment_unit_id)

```sql
SELECT pa.payment_unit_id,
       array_agg(pa.id ORDER BY pa.id) AS counted_rows,
       array_agg(DISTINCT pa.evidence_source) AS sources,
       array_agg(DISTINCT pa.gift_id) AS gifts,
       SUM(pa.amount_applied) AS summed
FROM payment_applications pa
WHERE pa.link_role = 'counted' AND pa.payment_unit_id IS NOT NULL
GROUP BY pa.payment_unit_id
HAVING count(*) > 1;
```

Same-gift groups are the offline-check double-description (QBO row + Donorbox
row) — consolidate to one counted row (keep the richer provenance, demote the
other to `corroborating`). Different-gift groups are REAL double-counted money
and must be resolved by a human before cutover.

## G8 — Donorbox cardinality (hard: first = 0; informational: second)

```sql
-- hard: the unit pointer and the raw pulled charge id never disagree
SELECT count(*) AS donorbox_pointer_conflicts
FROM payment_units pu
JOIN donorbox_donations d ON d.id = pu.donorbox_donation_id
WHERE d.stripe_charge_id IS NOT NULL
  AND pu.stripe_charge_id IS NOT NULL
  AND d.stripe_charge_id <> pu.stripe_charge_id;

-- informational: completeness — donations with no payment unit yet
SELECT count(*) AS donations_without_unit
FROM donorbox_donations d
WHERE NOT EXISTS (SELECT 1 FROM payment_units pu WHERE pu.donorbox_donation_id = d.id);
```

## Gate summary

Cutover (Phase 9) may proceed only when every **hard** gate returns zero AND
the G7 worklist has been fully consolidated. The informational counts are
recorded with the cutover PR for the audit trail.
