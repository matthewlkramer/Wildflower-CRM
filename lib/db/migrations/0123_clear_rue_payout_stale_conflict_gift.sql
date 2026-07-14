-- 0123 — Clear the stale conflict_gift_id on Jamie Rue's payout settlement link
--
-- Context: QuickBooks mislabeled Jamie Rue's donation deposit as "Dionne
-- Kirby". On 2026-07-12, while resolving that deposit (ep4HcTZpNC55tu88VGIIB,
-- Stripe payout po_1QbB1Y…, $148.90 net of Rue's $156.48 charge ch_3Qa1Px…),
-- the reviewer confirmed the payout↔deposit settlement with "keep existing
-- gift" pointing at the KIRBY gift recmMR2XcUrph7MSl ("$156 FY25 Kirby to
-- BWF") — believing, per the QB label, that this deposit's money was already
-- recorded there. It is not: the Kirby gift's money is Dionne Kirby's own
-- charge ch_3QZf3QAhXr9x8yiR0BJFSTLC (payout po_1Qa5as…, deposit e5RPV…),
-- booked as a counted per-charge ledger row on 2026-07-14 02:06.
--
-- The stale crumb is harmless to the per-charge LINK path but:
--   - wrongly claims Rue's money is already booked as the Kirby gift
--     (lineage/audit views show a false "kept gift" trail), and
--   - permanently blocks a per-charge MINT for this payout (the QB_CONFLICT
--     gate refuses to create a gift while the settlement says the money is
--     already recorded elsewhere).
-- Clearing it makes the link a plain settlement-only confirm — the correct
-- model: deposit settled, remaining money booked per-charge (the reviewer
-- links ch_3Qa1Px… to Jamie Rue's gift recpfi3uJpWGbmuSW in the UI).
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0123_clear_rue_payout_stale_conflict_gift.sql
--
-- Safety / idempotency:
--   - Touches exactly one row, and only while it still carries this exact
--     stale pointer AND the Kirby gift is genuinely booked from its own
--     charge (the counted per-charge ledger row exists) — i.e. only while
--     the "already recorded as this gift" claim is provably false.
--   - First run: UPDATE 1. Re-run: UPDATE 0.

UPDATE settlement_links sl
SET conflict_gift_id = NULL,
    updated_at       = now()
WHERE sl.id = 'sl_po_1QbB1YAhXr9x8yiRvekYilfK'
  AND sl.payout_id = 'po_1QbB1YAhXr9x8yiRvekYilfK'
  AND sl.conflict_gift_id = 'recmMR2XcUrph7MSl'
  AND sl.lifecycle = 'confirmed'
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = 'recmMR2XcUrph7MSl'
      AND pa.stripe_charge_id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  );

-- Verification (expect conflict_gift_id NULL, lifecycle still confirmed):
--   SELECT id, payout_id, deposit_staged_payment_id, lifecycle,
--          conflict_gift_id
--     FROM settlement_links
--    WHERE id = 'sl_po_1QbB1YAhXr9x8yiRvekYilfK';
