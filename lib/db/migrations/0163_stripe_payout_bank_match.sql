-- 0163: Phase 4 — tie a Stripe payout directly to the one real bank deposit it
-- settled as (docs/adr-bank-spine-money-model.md). Adds the columns, then runs a
-- CONSERVATIVE unambiguous 1:1 recompute.
--
-- This is a NEW relationship to the register-projected bank_deposits spine —
-- DISTINCT from settlement_links (whose target is a QBO Deposit staged_payments
-- row). settlement_links is untouched here; it is retired in Phase 9.
--
-- NOTE ON NUMBERING: 0162 is intentionally reserved for the Phase-3 QBO check-
-- composition backfill (pending inference-rule sign-off). This migration does
-- NOT depend on 0162 — only on 0159 (bank_deposits) — so it may be applied
-- before 0162 exists.
--
-- RECOMPUTE SCOPE (deliberately conservative): a payout is matched to a deposit
-- ONLY when the pairing is unambiguous 1:1 — exactly one unclaimed deposit has
-- the same amount + currency + date as the payout, AND that deposit matches
-- exactly one payout. Ambiguous cases (>1 equivalent deposit, e.g. two same-day
-- same-amount payouts) are LEFT UNMATCHED here and handled by the forward
-- matcher, which sets ambiguous_bank_match=true and a deterministic pairing (no
-- confirmation workflow). Date tolerance is a forward window (deposit_date in
-- [arrival_date, arrival_date + 5 days]): Stripe's arrival_date is when funds
-- LEAVE Stripe, and PROD data shows the deposit posts at the bank ~1 business
-- day later (never before), so an exact-date rule matches almost nothing. The
-- unambiguous-1:1 requirement still applies across the whole window, and the
-- UNIQUE index is the hard backstop against any double-claim.
--
-- WHY SAFE: additive columns (idempotent) + an idempotent recompute (re-run
-- skips already-matched payouts and already-claimed deposits). No row is ever
-- unmatched or overwritten. Re-runnable.
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0163_stripe_payout_bank_match.sql

ALTER TABLE stripe_payouts
  ADD COLUMN IF NOT EXISTS bank_deposit_id text REFERENCES bank_deposits(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ambiguous_bank_match boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_matched_at timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_payouts_bank_deposit_id_uq
  ON stripe_payouts (bank_deposit_id) WHERE bank_deposit_id IS NOT NULL;

-- Unambiguous 1:1 backfill.
WITH cand AS (
  SELECT p.id AS payout_id, d.id AS deposit_id
  FROM stripe_payouts p
  JOIN bank_deposits d
    ON d.amount = p.amount
   AND d.deposit_date >= p.arrival_date
   AND d.deposit_date <= p.arrival_date + INTERVAL '5 days'
   AND upper(d.currency) = upper(COALESCE(p.currency, 'USD'))
  WHERE p.status = 'paid'
    AND p.amount IS NOT NULL
    AND p.amount > 0
    AND p.bank_deposit_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM stripe_payouts p2 WHERE p2.bank_deposit_id = d.id
    )
),
uniq AS (
  SELECT payout_id, deposit_id
  FROM cand
  WHERE payout_id IN (SELECT payout_id FROM cand GROUP BY payout_id HAVING count(*) = 1)
    AND deposit_id IN (SELECT deposit_id FROM cand GROUP BY deposit_id HAVING count(*) = 1)
)
UPDATE stripe_payouts p
SET bank_deposit_id = u.deposit_id,
    bank_matched_at = now(),
    updated_at = now()
FROM uniq u
WHERE p.id = u.payout_id;
