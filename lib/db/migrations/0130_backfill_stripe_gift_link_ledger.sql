-- Migration 0130: Backfill Stripe gift links into the payment_applications ledger
--
-- Context
-- -------
-- gifts_and_payments.final_amount_stripe_charge_id is being retired as the
-- authoritative Stripe gift pointer.  The payment_applications table
-- (evidenceSource='stripe', linkRole='counted') is now the single source of
-- truth for every gift→charge link.  Any gift where the deprecated pointer
-- column is set and no counted ledger row exists yet needs a backfill row so
-- reads of the ledger are complete before the pointer column is dropped.
--
-- What this does
-- --------------
-- Inserts one payment_applications row per orphaned pointer, matching the
-- shape written by stripeGiftLink / reconciliationBundleCommit:
--   • evidence_source = 'stripe'
--   • link_role       = 'counted'
--   • created_the_gift = false   (backfill rows are links, not mints)
--   • amount_applied  = gift.amount  (best-effort; GROSS lives on the charge)
--   • staged_payment_id = null
-- Rows that already exist (idempotent ON CONFLICT DO NOTHING on the
-- unique index stripe_charge_id + gift_id + link_role).
--
-- Safety: additive only; no existing rows are mutated.

INSERT INTO payment_applications (
  id,
  staged_payment_id,
  gift_id,
  stripe_charge_id,
  donorbox_payment_id,
  evidence_source,
  link_role,
  amount_applied,
  created_the_gift,
  created_at
)
SELECT
  gen_random_uuid()::text                         AS id,
  NULL                                            AS staged_payment_id,
  g.id                                            AS gift_id,
  g.final_amount_stripe_charge_id                 AS stripe_charge_id,
  NULL                                            AS donorbox_payment_id,
  'stripe'                                        AS evidence_source,
  'counted'                                       AS link_role,
  g.amount                                        AS amount_applied,
  false                                           AS created_the_gift,
  NOW()                                           AS created_at
FROM gifts_and_payments g
WHERE g.final_amount_stripe_charge_id IS NOT NULL
  AND g.amount > 0
  AND NOT EXISTS (
    SELECT 1
    FROM payment_applications pa
    WHERE pa.stripe_charge_id = g.final_amount_stripe_charge_id
      AND pa.gift_id           = g.id
      AND pa.link_role         = 'counted'
  )
ON CONFLICT DO NOTHING;
