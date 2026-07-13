-- 0119 — Exclude fully-refunded, never-booked money from the review queue
--        (backfill)
--
-- Context: a Stripe charge that was fully refunded before it was ever booked
-- into a CRM gift — and the QuickBooks staged payment carrying its money —
-- still sat in the live queue as approvable money. The code now auto-excludes
-- both with the new 'refunded_charge' reason (at ingest/upsert for charges, a
-- sweep after ties/links land for QB rows). This backfill applies the same
-- rule to rows staged before the new code deployed. Real target: Erica
-- Cantoni's $248.19 QB payment dated 2022-02-02 (staged payment
-- eY58cEjOB9rluJXXrT9d8), the payout of Stripe charge
-- ch_3KO2ePAhXr9x8yiR1TxWHAeF, fully refunded the day it was charged.
--
-- Ordering: run AFTER 0118 (and/or Publish) has committed — the
-- 'refunded_charge' enum value must exist or this fails with "invalid input
-- value for enum".
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0119_exclude_refunded_stripe_charges.sql
--
-- Safety: idempotent; touches ONLY derived-pending, auto-classified rows
-- (status is DERIVED — a row already carrying an exclusion reason, any gift
-- link, a confirmed settlement link, or a counted payment_applications ledger
-- row is never touched; nor is a manual re-include pin,
-- classification_source = 'manual'). Charges booked into a gift keep flowing
-- through the existing refund-propagation path. Deposits mixing refunded and
-- live charges stay in the queue as real work. Everything is revertible from
-- the UI (re-include), same as failed_charge.

-- ── Step 1: fully-refunded, never-booked Stripe charges ────────────────────
-- Mirrors the insert/upsert classifier: refunded, not disputed (a dispute is
-- a chargeback, handled elsewhere), positive gross, cumulative refunds cover
-- the full gross (±half-cent float guard). Failed charges are already
-- excluded as failed_charge (exclusion_reason IS NULL filters them out).

UPDATE stripe_staged_charges
SET exclusion_reason = 'refunded_charge',
    updated_at = now()
WHERE exclusion_reason IS NULL          -- derived: not excluded
  AND matched_gift_id IS NULL           -- derived: pending (never booked)
  AND created_gift_id IS NULL
  AND classification_source = 'auto'    -- never clobber a manual pin
  AND refunded IS TRUE
  AND disputed IS NOT TRUE
  AND gross_amount > 0
  AND COALESCE(amount_refunded, gross_amount) >= gross_amount - 0.005;

-- ── Step 2: QB staged payments whose EXPLICIT Stripe trace is all refunded ─
-- Mirrors sweepRefundedQbStagedPayments(): the trace is the union of
-- per-charge QB ties (linked/proposed) and the charges of any payout
-- settlement-linked to this row as the deposit lump. Excluded only when at
-- least one traced charge is refunded_charge AND no traced charge is live
-- money (failed_charge contributes no money, so it doesn't block).

UPDATE staged_payments sp
SET exclusion_reason = 'refunded_charge',
    updated_at = now()
WHERE sp.exclusion_reason IS NULL       -- derived-pending, spelled out:
  AND sp.matched_gift_id IS NULL
  AND sp.created_gift_id IS NULL
  AND sp.group_reconciled_gift_id IS NULL
  AND NOT EXISTS (
        SELECT 1 FROM settlement_links sl
        WHERE sl.deposit_staged_payment_id = sp.id
          AND sl.lifecycle = 'confirmed')
  AND NOT EXISTS (
        SELECT 1 FROM payment_applications pa
        WHERE pa.payment_id = sp.id
          AND pa.link_role = 'counted')
  AND sp.classification_source = 'auto'
  AND EXISTS (
        SELECT 1 FROM stripe_staged_charges c
        WHERE (c.linked_qb_staged_payment_id = sp.id
               OR c.proposed_qb_staged_payment_id = sp.id
               OR c.stripe_payout_id IN (
                    SELECT sl.payout_id FROM settlement_links sl
                    WHERE sl.deposit_staged_payment_id = sp.id))
          AND c.exclusion_reason = 'refunded_charge')
  AND NOT EXISTS (
        SELECT 1 FROM stripe_staged_charges c
        WHERE (c.linked_qb_staged_payment_id = sp.id
               OR c.proposed_qb_staged_payment_id = sp.id
               OR c.stripe_payout_id IN (
                    SELECT sl.payout_id FROM settlement_links sl
                    WHERE sl.deposit_staged_payment_id = sp.id))
          AND (c.exclusion_reason IS NULL
               OR c.exclusion_reason NOT IN ('refunded_charge', 'failed_charge')));

-- ── Step 3: conservative direct NET trace (covers Erica Cantoni) ───────────
-- Historical QB rows staged before ties/settlement links existed have NO
-- explicit trace, so Step 2 can't reach them. This pass ties a derived-
-- pending auto QB row to a refunded_charge-excluded charge ONLY when the
-- evidence is airtight:
--   - the charge itself has no QB ties and its payout (if any) has no
--     settlement link and carries no other charge (single-charge payout);
--   - exact NET amount match (QB deposits book the net of processor fees);
--   - dates within ±20 days;
--   - the pairing is UNIQUE in both directions (exactly one candidate charge
--     for the row, exactly one candidate row for the charge) — ambiguity
--     means we leave the row in the queue for a human.

WITH pairs AS (
  SELECT sp.id AS sp_id, c.id AS charge_id
  FROM staged_payments sp
  JOIN stripe_staged_charges c
    ON c.net_amount = sp.amount
   AND c.date_received BETWEEN sp.date_received - 20 AND sp.date_received + 20
  WHERE sp.exclusion_reason IS NULL
    AND sp.matched_gift_id IS NULL
    AND sp.created_gift_id IS NULL
    AND sp.group_reconciled_gift_id IS NULL
    AND NOT EXISTS (
          SELECT 1 FROM settlement_links sl
          WHERE sl.deposit_staged_payment_id = sp.id
            AND sl.lifecycle = 'confirmed')
    AND NOT EXISTS (
          SELECT 1 FROM payment_applications pa
          WHERE pa.payment_id = sp.id
            AND pa.link_role = 'counted')
    AND sp.classification_source = 'auto'
    AND sp.amount > 0
    AND c.exclusion_reason = 'refunded_charge'
    AND c.linked_qb_staged_payment_id IS NULL
    AND c.proposed_qb_staged_payment_id IS NULL
    AND (c.stripe_payout_id IS NULL
         OR (NOT EXISTS (
               SELECT 1 FROM settlement_links sl
               WHERE sl.payout_id = c.stripe_payout_id)
             AND NOT EXISTS (
               SELECT 1 FROM stripe_staged_charges c2
               WHERE c2.stripe_payout_id = c.stripe_payout_id
                 AND c2.id <> c.id)))
),
uniq_rows AS (
  SELECT sp_id, min(charge_id) AS charge_id
  FROM pairs
  GROUP BY sp_id
  HAVING count(*) = 1
),
uniq_charges AS (
  SELECT charge_id
  FROM pairs
  GROUP BY charge_id
  HAVING count(*) = 1
)
UPDATE staged_payments sp
SET exclusion_reason = 'refunded_charge',
    updated_at = now()
FROM uniq_rows u
JOIN uniq_charges uc ON uc.charge_id = u.charge_id
WHERE sp.id = u.sp_id;

-- Verification (expected: the Erica Cantoni row + charge among the results):
--   SELECT id, payer_name, amount, date_received
--     FROM staged_payments WHERE exclusion_reason = 'refunded_charge';
--   SELECT id, gross_amount, amount_refunded, net_amount
--     FROM stripe_staged_charges WHERE exclusion_reason = 'refunded_charge';
--   -- Spot-check the named target:
--   SELECT id, exclusion_reason FROM staged_payments
--    WHERE id = 'eY58cEjOB9rluJXXrT9d8';
