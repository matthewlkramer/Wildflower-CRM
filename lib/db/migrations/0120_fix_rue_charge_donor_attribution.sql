-- 0120 — Fix wrong donor attribution on Jamie Rue's Stripe charge
--
-- Context: Stripe charge ch_3Qa1PxAhXr9x8yiR0GYIXgbd ($156.48 gross,
-- 2024-12-30) is Jamie Rue's donation — payer_name = 'Jamie Rue', description
-- "donation to Invest in the Next Generation of Black Educators! from
-- jamierue@gmail.com" — but its auto-matched donor FK points at Dionne Kirby
-- (person recwTcVIeS6VCL7Lh). The QuickBooks memo on the deposit that carried
-- this payout also says "Donation from Dionne Kirby via Stripe", so the
-- reconciliation workbench card is labeled "Dionne Kirby" and a Create-gift
-- from that card would credit the wrong donor. (Kirby's OWN $156.48 donation
-- is a different charge — ch_3QZf3Q…, payout po_1Qa5as… — already reconciled;
-- this row is the unrelated same-amount Rue donation deposited three days
-- later.)
--
-- Repoint the charge's donor to Jamie Rue (person recBovpzr5OAX6O5y).
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0120_fix_rue_charge_donor_attribution.sql
--
-- Safety / idempotency:
--   - Touches exactly one row, and only while it still carries the wrong
--     donor (individual_giver_person_id = Kirby) and has never been booked
--     (no matched/created gift). If the row was already fixed — e.g. the
--     reviewer linked the charge to Rue's gift, which adopts the gift's
--     donor — this UPDATE matches zero rows and is a no-op.
--   - Guarded on the Rue person row existing, so the FK can never error.
--   - Donor XOR is preserved: organization_id and household_id are already
--     NULL on this row and are pinned NULL here.

UPDATE stripe_staged_charges
SET individual_giver_person_id = 'recBovpzr5OAX6O5y',  -- Jamie Rue
    organization_id            = NULL,
    household_id               = NULL,
    updated_at                 = now()
WHERE id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd'
  AND individual_giver_person_id = 'recwTcVIeS6VCL7Lh' -- still mis-attributed to Dionne Kirby
  AND matched_gift_id IS NULL                          -- never booked (a link would
  AND created_gift_id IS NULL                          -- have adopted the gift's donor)
  AND EXISTS (SELECT 1 FROM people WHERE id = 'recBovpzr5OAX6O5y');

-- Verification (expect donor_person = 'recBovpzr5OAX6O5y' — or a gift link,
-- if the reviewer already reconciled the charge in the UI first):
--   SELECT id, payer_name, individual_giver_person_id AS donor_person,
--          matched_gift_id, created_gift_id
--     FROM stripe_staged_charges
--    WHERE id = 'ch_3Qa1PxAhXr9x8yiR0GYIXgbd';
