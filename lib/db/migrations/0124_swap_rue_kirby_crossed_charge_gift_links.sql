-- 0124 — Un-cross the Rue/Kirby Stripe charge↔gift links
--
-- Context: QuickBooks mislabeled Jamie Rue's deposit as "Dionne Kirby", so on
-- 2026-07-12 the reviewer confirmed Dionne Kirby (recwTcVIeS6VCL7Lh) as the
-- DONOR of Jamie Rue's charge ch_3Qa1PxAhXr9x8yiR0GYIXgbd. The charge card's
-- gift-proposal pool is donor-scoped, so once the correct Kirby link
-- (ch_3QZf3Q… → recmMR2…, booked 2026-07-14 02:06) was reverted during the
-- 409 troubleshooting, the ONLY candidate the Rue card could propose was the
-- Kirby gift — and at 2026-07-14 04:46 that wrong pairing was confirmed.
--
-- Current (wrong) state, verified 2026-07-14:
--   - ch_3Qa1Px… (Jamie Rue, $156.48, payout po_1QbB1Y…, deposit 31719):
--       donor = Dionne Kirby, matched_gift_id = recmMR2… (Kirby's gift),
--       counted+confirmed ledger row → recmMR2…
--   - ch_3QZf3Q… (Dionne Kirby, $156.48, payout po_1Qa5as…, deposit 31718):
--       donor = Dionne Kirby (correct), NO gift link, NO ledger row,
--       match_status = 'suggested' — keeps deposit 31718 in the queue.
--   - Kirby's gift recmMR2… ("$156 FY25 Kirby to BWF") is owned by Rue's
--     charge (incl. final_amount_stripe_charge_id = ch_3Qa1Px…); Rue's gift
--     recpfi3… ("$156 FY25 Rue to BWF") has no ledger rows, tie 'missing',
--     final_amount_source 'human'.
--   - sl_po_1Qa5as… still carries the stale conflict_gift_id = recmMR2…
--     crumb (same shape 0123 cleared on the Rue payout link).
--
-- Target state = exactly what the app's own charge-link path would have
-- written (link ledger row + charge stamps + final-amount provenance stamp +
-- quickbooks_tie_status re-derivation), with each charge tied to its own
-- donor's gift.
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0124_swap_rue_kirby_crossed_charge_gift_links.sql
--
-- Safety / idempotency:
--   - Every statement is guarded on the exact current wrong state, so the
--     whole file is a no-op if the links were already fixed (in the UI or by
--     a re-run). First run: each statement reports 1 row (INSERT 0 1 /
--     UPDATE 1). Re-run: all zeros.
--   - Statement order matters for the partial unique indexes
--     (stripe_staged_charges.matched_gift_id and the counted
--     (stripe_charge_id, gift_id) book-once key): Rue's pointers are moved
--     OFF the Kirby gift before Kirby's charge claims it.
--   - No BEGIN/COMMIT here — psql -1 wraps the file in one transaction.

-- 1) Retarget the counted ledger row on Jamie Rue's charge: Kirby's gift →
--    Rue's gift. Guarded so it only fires while the row still points at the
--    Kirby gift AND Rue's gift is not counted-claimed by any other anchor.
UPDATE payment_applications pa
SET gift_id    = 'recpfi3uJpWGbmuSW',
    note       = 'repair 0124: retargeted from recmMR2XcUrph7MSl (Kirby) — QB payer-label mix-up crossed the twin $156 gifts',
    updated_at = now()
WHERE pa.stripe_charge_id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd'
  AND pa.gift_id = 'recmMR2XcUrph7MSl'
  AND pa.link_role = 'counted'
  AND pa.lifecycle = 'confirmed'
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications other
    WHERE other.gift_id = 'recpfi3uJpWGbmuSW'
      AND other.link_role = 'counted'
  );

-- 2) Fix Jamie Rue's charge row: real donor + gift pointer. Frees the unique
--    matched_gift_id claim on the Kirby gift for step 4.
UPDATE stripe_staged_charges c
SET individual_giver_person_id = 'recBovpzr5OAX6O5y',
    matched_gift_id            = 'recpfi3uJpWGbmuSW',
    updated_at                 = now()
WHERE c.id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd'
  AND c.matched_gift_id = 'recmMR2XcUrph7MSl'
  AND c.individual_giver_person_id = 'recwTcVIeS6VCL7Lh'
  AND c.organization_id IS NULL
  AND c.household_id IS NULL
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.stripe_charge_id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd'
      AND pa.gift_id = 'recpfi3uJpWGbmuSW'
      AND pa.link_role = 'counted'
  );

-- 3) Restore the counted ledger row for Dionne Kirby's charge → Kirby's gift
--    (the row that existed at 02:06 before the revert). amount_applied is the
--    charge GROSS, mirroring the app's bookStripeChargeApplication. Guarded on
--    both the ledger AND the charge row still being unlinked.
INSERT INTO payment_applications
  (id, gift_id, stripe_charge_id, amount_applied, evidence_source,
   match_method, link_role, lifecycle, confirmed_by_user_id, confirmed_at,
   note, created_the_gift, created_at, updated_at)
SELECT
  'pa_repair0124_kirby156', 'recmMR2XcUrph7MSl', 'ch_3QZf3QAhXr9x8yiR0BJFSTLC',
  156.48, 'stripe', 'human', 'counted', 'confirmed', 'usr_matthew_kramer',
  now(), 'repair 0124: restores the correct Kirby charge→gift link reverted during the 409 troubleshooting', false, now(), now()
WHERE NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.stripe_charge_id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC'
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications other
    WHERE other.gift_id = 'recmMR2XcUrph7MSl'
      AND other.link_role = 'counted'
  )
  AND EXISTS (
    SELECT 1 FROM stripe_staged_charges c
    WHERE c.id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC'
      AND c.matched_gift_id IS NULL
      AND c.created_gift_id IS NULL
  );

-- 4) Fix Dionne Kirby's charge row: gift pointer + the full confirmed-match
--    stamp set the app's link path writes (matched + match_confirmed_* +
--    approved_*; mirrors reconciliationBundleCommit). Runs only after step 2
--    released the unique matched_gift_id claim.
UPDATE stripe_staged_charges c
SET matched_gift_id            = 'recmMR2XcUrph7MSl',
    match_status               = 'matched',
    match_confirmed_by_user_id = 'usr_matthew_kramer',
    match_confirmed_at         = now(),
    approved_by_user_id        = 'usr_matthew_kramer',
    approved_at                = now(),
    updated_at                 = now()
WHERE c.id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC'
  AND c.matched_gift_id IS NULL
  AND c.created_gift_id IS NULL
  AND c.individual_giver_person_id = 'recwTcVIeS6VCL7Lh'
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.stripe_charge_id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC'
      AND pa.gift_id = 'recmMR2XcUrph7MSl'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM stripe_staged_charges other
    WHERE other.matched_gift_id = 'recmMR2XcUrph7MSl'
      AND other.id <> c.id
  );

-- 5) Clear the stale conflict crumb on the Kirby payout's settlement link
--    (same rationale as 0123: with the money booked per-charge, the link is a
--    plain settlement-only confirm; the crumb otherwise blocks per-charge
--    MINT paths and shows a false "kept gift" trail).
UPDATE settlement_links sl
SET conflict_gift_id = NULL,
    updated_at       = now()
WHERE sl.id = 'sl_po_1Qa5asAhXr9x8yiRugjbC5EU'
  AND sl.payout_id = 'po_1Qa5asAhXr9x8yiRugjbC5EU'
  AND sl.conflict_gift_id = 'recmMR2XcUrph7MSl'
  AND sl.lifecycle = 'confirmed'
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = 'recmMR2XcUrph7MSl'
      AND pa.stripe_charge_id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
  );

-- 6) Fix the final-amount provenance on the KIRBY gift: it currently points
--    at Rue's charge (stamped by the wrong 04:46 link). Re-point it to
--    Kirby's own charge — what the app's stampGiftFinalAmount would have
--    written for the restored link. Amount is deliberately untouched
--    (Stripe stamps never overwrite the human-entered amount).
UPDATE gifts_and_payments g
SET final_amount_stripe_charge_id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC',
    updated_at                    = now()
WHERE g.id = 'recmMR2XcUrph7MSl'
  AND g.final_amount_source = 'stripe'
  AND g.final_amount_stripe_charge_id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd'
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = 'recmMR2XcUrph7MSl'
      AND pa.stripe_charge_id = 'ch_3QZf3QAhXr9x8yiR0BJFSTLC'
      AND pa.link_role = 'counted'
  );

-- 7) Stamp the RUE gift's final-amount provenance from its (retargeted)
--    charge link — the app's link path stamps source='stripe' + the charge
--    pointer (a Stripe stamp may overwrite a prior 'human' source).
UPDATE gifts_and_payments g
SET final_amount_source           = 'stripe',
    final_amount_stripe_charge_id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd',
    updated_at                    = now()
WHERE g.id = 'recpfi3uJpWGbmuSW'
  AND g.final_amount_source = 'human'
  AND g.final_amount_stripe_charge_id IS NULL
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = 'recpfi3uJpWGbmuSW'
      AND pa.stripe_charge_id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd'
      AND pa.link_role = 'counted'
  );

-- 8) Re-derive quickbooks_tie_status for the RUE gift. The tie derivation
--    (applyGiftQbTieMany) reads counted Stripe rows too: with a counted
--    156.48 row against the 156.00 gift and no QB row, the derived value is
--    'amount_mismatch' (the Kirby gift already carries 'amount_mismatch' for
--    the same shape and stays correct). Guarded on exactly that shape.
UPDATE gifts_and_payments g
SET quickbooks_tie_status = 'amount_mismatch',
    updated_at            = now()
WHERE g.id = 'recpfi3uJpWGbmuSW'
  AND g.quickbooks_tie_status = 'missing'
  AND g.amount = 156.00
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.gift_id = 'recpfi3uJpWGbmuSW'
      AND pa.stripe_charge_id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd'
      AND pa.link_role = 'counted'
      AND pa.amount_applied = 156.48
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications qb
    WHERE qb.gift_id = 'recpfi3uJpWGbmuSW'
      AND qb.evidence_source = 'quickbooks'
      AND qb.link_role = 'counted'
  );

-- Verification (run after applying):
--   -- Each charge → its own donor's gift, both matched + fully stamped:
--   SELECT c.id, c.match_status, c.matched_gift_id, c.individual_giver_person_id,
--          c.match_confirmed_by_user_id, c.approved_by_user_id
--     FROM stripe_staged_charges c
--    WHERE c.id IN ('ch_3Qa1PxAhXr9x8yiR0GYIXgbd','ch_3QZf3QAhXr9x8yiR0BJFSTLC');
--   -- expect: ch_3Qa1Px → recpfi3uJpWGbmuSW / recBovpzr5OAX6O5y (Rue)
--   --         ch_3QZf3Q → recmMR2XcUrph7MSl / recwTcVIeS6VCL7Lh (Kirby)
--
--   -- Ledger: exactly one counted row per gift, from its own charge:
--   SELECT pa.gift_id, pa.stripe_charge_id, pa.link_role, pa.lifecycle, pa.amount_applied
--     FROM payment_applications pa
--    WHERE pa.gift_id IN ('recmMR2XcUrph7MSl','recpfi3uJpWGbmuSW');
--
--   -- Gift derived state: both 'amount_mismatch' (156.48 settled vs 156.00
--   -- entered), provenance pointing at each gift's OWN charge:
--   SELECT g.id, g.quickbooks_tie_status, g.final_amount_source,
--          g.final_amount_stripe_charge_id
--     FROM gifts_and_payments g
--    WHERE g.id IN ('recmMR2XcUrph7MSl','recpfi3uJpWGbmuSW');
--
--   -- Settlement links: both confirmed, no conflict crumbs:
--   SELECT id, deposit_staged_payment_id, lifecycle, conflict_gift_id
--     FROM settlement_links
--    WHERE payout_id IN ('po_1Qa5asAhXr9x8yiRugjbC5EU','po_1QbB1YAhXr9x8yiRvekYilfK');
