-- 0168: Phase 9c — demote the payout↔QBO settlement tie to a plain pairing
-- column (docs/adr-bank-spine-money-model.md). `settlement_links` carried a
-- proposed/confirmed lifecycle around what is a deterministic fact: "this QBO
-- deposit row books this Stripe payout". The bank-spine model keeps the FACT
-- (the accounting comparer needs the pairing) and retires the workflow — the
-- judgment moves to the qbo_accounting_checks correction worklist.
--
-- This file:
--   1. Adds staged_payments.settled_stripe_payout_id (SET NULL off the payout;
--      UNIQUE per payout — a payout settles as at most one QBO lump).
--   2. Backfills it from every CONFIRMED settlement link (the human-confirmed
--      pairings are preserved as plain facts; proposed links are workflow
--      state and are NOT carried over — the comparer re-pairs deterministically).
--
-- The table itself is dropped by 0169 AFTER the app release that stops
-- reading/writing it is deployed (apply order: deploy → 0168 already applied →
-- 0169).
--
-- WHY SAFE: additive column + fill-only backfill; no rows deleted, nothing
-- else written. Idempotent: the UPDATE only fills NULLs.
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0168_settled_stripe_payout_id.sql

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS settled_stripe_payout_id text
  REFERENCES stripe_payouts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "staged_payments_settled_stripe_payout_id_uq"
  ON staged_payments (settled_stripe_payout_id)
  WHERE settled_stripe_payout_id IS NOT NULL;

UPDATE staged_payments sp
SET settled_stripe_payout_id = sl.payout_id
FROM settlement_links sl
WHERE sl.deposit_staged_payment_id = sp.id
  AND sl.lifecycle = 'confirmed'
  AND sp.settled_stripe_payout_id IS NULL;
