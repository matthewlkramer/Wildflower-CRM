-- 0145: Backfill source_links from the five retired pointer columns and
-- rewrite the note-marker supersede protocol to the match_method enum value
-- (ADR: docs/adr-source-link-ledger.md, phase 2).
--
-- Idempotent: deterministic ids + ON CONFLICT DO NOTHING (the conflict guard
-- is belt-and-suspenders only — the phase-1 pre-flight proved zero
-- double-claims; a conflict here means new drift, reconcile the affected-row
-- counts against the pointer counts, do not trust a clean exit).
--
-- MUST run AFTER 0144 (separate psql invocation: the 'charge_tie_supersede'
-- enum value cannot be used in the transaction that added it).
--
-- Apply (from repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0145_backfill_source_links.sql
--
-- Verify afterwards (counts must match pointer counts; see 0144_RUNBOOK.md).

-- 1) CONFIRMED charge↔QB ties (linked_qb_staged_payment_id).
--    Provenance from the adjacent audit columns where present, else
--    system_confirmed (the settlement_links 0089 precedent for confirmed rows
--    predating audit capture).
INSERT INTO source_links
  (id, link_type, stripe_charge_id, qb_staged_payment_id,
   lifecycle, provenance, confirmed_by_user_id, confirmed_at)
SELECT
  'srcl_ct_' || c.id, 'charge_qb_tie', c.id, c.linked_qb_staged_payment_id,
  'confirmed',
  CASE WHEN c.cross_processor_linked_by_user_id IS NOT NULL
       THEN 'human'::source_link_provenance
       ELSE 'system_confirmed'::source_link_provenance END,
  c.cross_processor_linked_by_user_id,
  c.cross_processor_linked_at
FROM stripe_staged_charges c
WHERE c.linked_qb_staged_payment_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 2) PROPOSED charge↔QB ties (proposed_qb_staged_payment_id). Skipped when a
--    confirmed tie already exists for the charge (same deterministic id —
--    confirmed wins; the app clears proposals on approve so overlap is drift).
INSERT INTO source_links
  (id, link_type, stripe_charge_id, qb_staged_payment_id,
   lifecycle, provenance)
SELECT
  'srcl_ct_' || c.id, 'charge_qb_tie', c.id, c.proposed_qb_staged_payment_id,
  'proposed', 'system'
FROM stripe_staged_charges c
WHERE c.proposed_qb_staged_payment_id IS NOT NULL
  AND c.linked_qb_staged_payment_id IS NULL
ON CONFLICT DO NOTHING;

-- 3) Fee-row claims (linked_fee_qb_staged_payment_id) — auto-claimed sibling
--    fee rows; always confirmed. The claim itself is system-derived (the
--    human confirmed the DONOR-line tie), so provenance is system_confirmed
--    with the tie's audit timestamps carried for the trail.
INSERT INTO source_links
  (id, link_type, stripe_charge_id, qb_staged_payment_id,
   lifecycle, provenance, confirmed_by_user_id, confirmed_at)
SELECT
  'srcl_fee_' || c.id, 'charge_fee_row', c.id, c.linked_fee_qb_staged_payment_id,
  'confirmed', 'system_confirmed',
  c.cross_processor_linked_by_user_id,
  c.cross_processor_linked_at
FROM stripe_staged_charges c
WHERE c.linked_fee_qb_staged_payment_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4) Donorbox ↔ QB counterparts.
INSERT INTO source_links
  (id, link_type, donorbox_donation_id, qb_staged_payment_id,
   lifecycle, provenance, confirmed_by_user_id, confirmed_at)
SELECT
  'srcl_dbq_' || d.id, 'donorbox_qb', d.id, d.linked_qb_staged_payment_id,
  'confirmed',
  CASE WHEN d.cross_processor_linked_by_user_id IS NOT NULL
       THEN 'human'::source_link_provenance
       ELSE 'system_confirmed'::source_link_provenance END,
  d.cross_processor_linked_by_user_id,
  d.cross_processor_linked_at
FROM donorbox_donations d
WHERE d.linked_qb_staged_payment_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5) Donorbox ↔ Stripe-charge counterparts.
INSERT INTO source_links
  (id, link_type, donorbox_donation_id, stripe_charge_id,
   lifecycle, provenance, confirmed_by_user_id, confirmed_at)
SELECT
  'srcl_dbc_' || d.id, 'donorbox_charge', d.id, d.linked_stripe_charge_id,
  'confirmed',
  CASE WHEN d.cross_processor_linked_by_user_id IS NOT NULL
       THEN 'human'::source_link_provenance
       ELSE 'system_confirmed'::source_link_provenance END,
  d.cross_processor_linked_by_user_id,
  d.cross_processor_linked_at
FROM donorbox_donations d
WHERE d.linked_stripe_charge_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 6) Retire the string-marker supersede protocol: tie-derived moved ledger
--    rows get the first-class enum value; the note text is PRESERVED for the
--    audit trail (it simply stops being machine-parsed).
UPDATE payment_applications
SET match_method = 'charge_tie_supersede'
WHERE note LIKE 'charge_tie_supersede:%'
  AND match_method IS DISTINCT FROM 'charge_tie_supersede';
