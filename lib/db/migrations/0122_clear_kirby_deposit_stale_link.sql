-- 0122 — Clear the stale legacy gift pointer on QB deposit e5RPVWzQ79CD_jEBqrre1
--
-- ⚠ ORDERING: apply BEFORE 0120_payment_applications_gift_link_parity.sql.
--   The parity backfill converts every legacy matched_gift_id into a counted
--   payment_applications ledger row. This deposit's pointer is a stale
--   pre-cutover UI write that must NOT be converted (see below), or the
--   "$156 FY25 Kirby to BWF" gift would carry BOTH a coarse deposit ledger row
--   ($148.90) AND, once the reviewer relinks Kirby's charge, a per-charge
--   ledger row ($156.48) — double-counting the same money.
--
-- Context: on 2026-07-14 ~01:20, while the pre-cutover build was still live,
-- a reviewer unlink/relink session left QB deposit e5RPVWzQ79CD_jEBqrre1
-- (Stripe payout po_1Qa5as…, Dionne Kirby's $156.48 donation, $148.90 net)
-- with a deposit-level matched_gift_id = recmMR2XcUrph7MSl ("$156 FY25 Kirby
-- to BWF") but no match_confirmed_at and no ledger row. The correct model for
-- this deposit is settlement-only (payout↔deposit link confirmed 07-13 22:03)
-- with the gift credited per-charge — the reviewer will relink Kirby's charge
-- (ch_3QZf3Q…) to the gift in the UI, which writes the proper per-charge
-- ledger row.
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0122_clear_kirby_deposit_stale_link.sql
--
-- Safety / idempotency:
--   - Touches exactly one row, and only while it still carries this exact
--     stale pointer AND still has no counted ledger row of its own. If the
--     parity backfill already converted the pointer (counted ledger row
--     exists), this deliberately matches zero rows — clearing the pointer
--     then would NOT remove the ledger row, so it flags for manual review
--     instead (delete the counted payment_applications row for
--     (payment_id = 'e5RPVWzQ79CD_jEBqrre1', gift_id = 'recmMR2XcUrph7MSl')
--     and re-run).
--   - First run: UPDATE 1. Re-run: UPDATE 0.

UPDATE staged_payments sp
SET matched_gift_id = NULL,
    updated_at      = now()
WHERE sp.id = 'e5RPVWzQ79CD_jEBqrre1'
  AND sp.matched_gift_id = 'recmMR2XcUrph7MSl'
  AND sp.match_confirmed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.payment_id = sp.id
      AND pa.gift_id = sp.matched_gift_id
      AND pa.link_role = 'counted'
  );

-- Verification (expect matched_gift_id NULL, settlement link still confirmed):
--   SELECT sp.id, sp.matched_gift_id, sp.match_confirmed_at,
--          (SELECT lifecycle FROM settlement_links sl
--            WHERE sl.deposit_staged_payment_id = sp.id) AS settlement
--     FROM staged_payments sp WHERE sp.id = 'e5RPVWzQ79CD_jEBqrre1';
