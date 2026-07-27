-- 0191: backfill the three legacy QBO tie mechanisms into source_links
-- (docs/adr-qbo-evidence-grain.md §3). Idempotent (deterministic ids +
-- ON CONFLICT DO NOTHING); requires 0189 + 0190 applied first.
--
--   bank_deposit_qbo_register             → qbo_register_deposit (match_basis
--                                           from the actual day gap)
--   deposit_qbo_components                → qbo_line_deposit
--   staged_payments.settled_stripe_payout_id → payout_qb_settlement
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0191_backfill_qbo_ties_to_source_links.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

INSERT INTO source_links (
  id, link_type, bank_transaction_id, bank_deposit_id,
  lifecycle, provenance, match_basis
)
SELECT
  'srcl_qrd_' || r.bank_transaction_id,
  'qbo_register_deposit',
  r.bank_transaction_id,
  r.bank_deposit_id,
  'confirmed',
  'system',
  CASE abs(bt.txn_date - d.deposit_date)
    WHEN 0 THEN 'same_day_unique_amount'
    WHEN 1 THEN 'one_day_unique_amount'
    WHEN 2 THEN 'two_day_unique_amount'
    ELSE 'three_day_unique_amount'
  END::source_link_match_basis
FROM bank_deposit_qbo_register r
JOIN bank_transactions bt ON bt.id = r.bank_transaction_id
JOIN bank_deposits d ON d.id = r.bank_deposit_id
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_links (
  id, link_type, qb_staged_payment_id, bank_deposit_id,
  lifecycle, provenance, match_basis
)
SELECT
  'srcl_qld_' || c.staged_payment_id,
  'qbo_line_deposit',
  c.staged_payment_id,
  c.bank_deposit_id,
  'confirmed',
  'system',
  c.match_basis::text::source_link_match_basis
FROM deposit_qbo_components c
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_links (
  id, link_type, qb_staged_payment_id, stripe_payout_id,
  lifecycle, provenance, match_basis
)
SELECT
  'srcl_pqs_' || sp.settled_stripe_payout_id,
  'payout_qb_settlement',
  sp.id,
  sp.settled_stripe_payout_id,
  'confirmed',
  'system',
  'settled_pairing'
FROM staged_payments sp
WHERE sp.settled_stripe_payout_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Reconcile: each backfill's link count must equal its legacy count.
DO $$
DECLARE
  legacy bigint; links bigint;
BEGIN
  SELECT count(*) INTO legacy FROM bank_deposit_qbo_register;
  SELECT count(*) INTO links FROM source_links WHERE link_type = 'qbo_register_deposit';
  IF links < legacy THEN
    RAISE EXCEPTION 'qbo_register_deposit backfill incomplete: % links vs % legacy rows', links, legacy;
  END IF;
  SELECT count(*) INTO legacy FROM deposit_qbo_components;
  SELECT count(*) INTO links FROM source_links WHERE link_type = 'qbo_line_deposit';
  IF links < legacy THEN
    RAISE EXCEPTION 'qbo_line_deposit backfill incomplete: % links vs % legacy rows', links, legacy;
  END IF;
  SELECT count(*) INTO legacy FROM staged_payments WHERE settled_stripe_payout_id IS NOT NULL;
  SELECT count(*) INTO links FROM source_links WHERE link_type = 'payout_qb_settlement';
  IF links < legacy THEN
    RAISE EXCEPTION 'payout_qb_settlement backfill incomplete: % links vs % legacy rows', links, legacy;
  END IF;
END $$;
