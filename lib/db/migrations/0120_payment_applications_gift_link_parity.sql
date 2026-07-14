-- Migration 0120: Close the payment_applications parity gap for the four
-- legacy gift-link columns, ahead of the ledger read-cutover (drop tail).
--
-- CONTEXT: 0066 backfilled the ledger from the legacy linkage as of Phase 2,
-- and the app has dual-written ledger rows on every mint/link/group/split
-- since. But rows reconciled in the window between 0066 and full dual-write
-- coverage carry a legacy link (staged_payments.matched_gift_id /
-- created_gift_id / group_reconciled_gift_id, or
-- gifts_and_payments.final_amount_qb_staged_payment_id) with NO counted ledger
-- row. This file re-runs the 0066 A/B/C/E sources (D — staged_payment_splits —
-- was dropped in 0115; split rows are ledger-native) so that EVERY legacy link
-- has a counted quickbooks ledger row, then HARD-FAILS the transaction if any
-- gap remains. After this file applies cleanly, reads can flip to the ledger.
--
-- IDEMPOTENT / RE-RUNNABLE: every INSERT is ON CONFLICT DO NOTHING against the
-- role-scoped partial unique (payment_id, gift_id) WHERE link_role='counted'
-- (0087 made the 0066-era unique partial), so re-running never duplicates.
--
-- AMOUNT GUARD: amount_applied has a CHECK (> 0 for counted rows), so every
-- source filters null / non-positive amounts — mirroring the dual-write guard.
-- The final DO block treats a positive-amount gap as fatal AND reports (as a
-- WARNING, non-fatal) any zero/null-amount legacy links, which cannot be
-- represented in the ledger and must be investigated by hand before the read
-- cutover ships. Dev has zero such rows.
--
-- PROVENANCE: match_method mirrors 0066 — auto_applied AND match_confirmed_at
-- => 'system_confirmed'; auto_applied alone => 'system'; else 'human'.
--
-- ORDERING: apply AFTER 0119. Apply with psql -1 (single transaction; no
-- BEGIN/COMMIT in-file):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0120_payment_applications_gift_link_parity.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0120_payment_applications_gift_link_parity.sql   (prod)

-- A. matched_gift_id -> link to a PRE-EXISTING gift (no mint). ---------------
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, link_role, lifecycle, confirmed_by_user_id, confirmed_at,
  created_the_gift, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  sp.id,
  sp.matched_gift_id,
  sp.amount,
  'quickbooks'::payment_application_evidence_source,
  (CASE
     WHEN sp.auto_applied AND sp.match_confirmed_at IS NOT NULL
       THEN 'system_confirmed'
     WHEN sp.auto_applied THEN 'system'
     ELSE 'human' END)
    ::payment_application_match_method,
  'counted'::payment_application_link_role,
  'confirmed'::payment_application_lifecycle,
  sp.match_confirmed_by_user_id,
  sp.match_confirmed_at,
  false,
  now(), now()
FROM staged_payments sp
JOIN gifts_and_payments g ON g.id = sp.matched_gift_id
WHERE sp.matched_gift_id IS NOT NULL
  AND sp.amount IS NOT NULL
  AND sp.amount > 0
ON CONFLICT (payment_id, gift_id) WHERE link_role = 'counted' DO NOTHING;

-- B. created_gift_id -> a NEW gift was minted from this payment. -------------
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, link_role, lifecycle, confirmed_by_user_id, confirmed_at,
  created_the_gift, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  sp.id,
  sp.created_gift_id,
  sp.amount,
  'quickbooks'::payment_application_evidence_source,
  (CASE
     WHEN sp.auto_applied AND sp.match_confirmed_at IS NOT NULL
       THEN 'system_confirmed'
     WHEN sp.auto_applied THEN 'system'
     ELSE 'human' END)
    ::payment_application_match_method,
  'counted'::payment_application_link_role,
  'confirmed'::payment_application_lifecycle,
  sp.match_confirmed_by_user_id,
  sp.match_confirmed_at,
  true,
  now(), now()
FROM staged_payments sp
JOIN gifts_and_payments g ON g.id = sp.created_gift_id
WHERE sp.created_gift_id IS NOT NULL
  AND sp.amount IS NOT NULL
  AND sp.amount > 0
ON CONFLICT (payment_id, gift_id) WHERE link_role = 'counted' DO NOTHING;

-- C. group_reconciled_gift_id -> one row per NON-representative member. ------
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, link_role, lifecycle, confirmed_by_user_id, confirmed_at,
  created_the_gift, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  sp.id,
  sp.group_reconciled_gift_id,
  sp.amount,
  'quickbooks'::payment_application_evidence_source,
  (CASE
     WHEN sp.auto_applied AND sp.match_confirmed_at IS NOT NULL
       THEN 'system_confirmed'
     WHEN sp.auto_applied THEN 'system'
     ELSE 'human' END)
    ::payment_application_match_method,
  'counted'::payment_application_link_role,
  'confirmed'::payment_application_lifecycle,
  sp.match_confirmed_by_user_id,
  sp.match_confirmed_at,
  false,
  now(), now()
FROM staged_payments sp
JOIN gifts_and_payments g ON g.id = sp.group_reconciled_gift_id
WHERE sp.group_reconciled_gift_id IS NOT NULL
  AND sp.amount IS NOT NULL
  AND sp.amount > 0
ON CONFLICT (payment_id, gift_id) WHERE link_role = 'counted' DO NOTHING;

-- E. Supplement from the gift's QB final-amount pointer. ----------------------
-- Catches QB-stamped gifts whose staged-row link columns were cleared but whose
-- provenance pointer survives. NOT EXISTS covers non-counted rows too; the
-- amount is the GIFT's amount (the stamped figure), mirroring 0066.
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, link_role, lifecycle, confirmed_by_user_id, confirmed_at,
  created_the_gift, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  g.final_amount_qb_staged_payment_id,
  g.id,
  g.amount,
  'quickbooks'::payment_application_evidence_source,
  'human'::payment_application_match_method,
  'counted'::payment_application_link_role,
  'confirmed'::payment_application_lifecycle,
  NULL,
  NULL,
  false,
  now(), now()
FROM gifts_and_payments g
JOIN staged_payments sp ON sp.id = g.final_amount_qb_staged_payment_id
WHERE g.final_amount_qb_staged_payment_id IS NOT NULL
  AND g.amount IS NOT NULL
  AND g.amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.payment_id = g.final_amount_qb_staged_payment_id
      AND pa.gift_id = g.id
      AND pa.link_role = 'counted'
  )
ON CONFLICT (payment_id, gift_id) WHERE link_role = 'counted' DO NOTHING;

-- PARITY GATE (fatal): after the inserts above, every positive-amount legacy
-- link must have its counted quickbooks ledger row. If not, ABORT the whole
-- transaction — the read cutover must not ship on top of a gap.
DO $$
DECLARE
  gap_matched  int;
  gap_created  int;
  gap_group    int;
  gap_ptr      int;
  zero_amount  int;
BEGIN
  SELECT count(*) INTO gap_matched FROM staged_payments sp
   WHERE sp.matched_gift_id IS NOT NULL
     AND sp.amount IS NOT NULL AND sp.amount > 0
     AND EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = sp.matched_gift_id)
     AND NOT EXISTS (
       SELECT 1 FROM payment_applications pa
       WHERE pa.payment_id = sp.id AND pa.gift_id = sp.matched_gift_id
         AND pa.link_role = 'counted' AND pa.evidence_source = 'quickbooks');

  SELECT count(*) INTO gap_created FROM staged_payments sp
   WHERE sp.created_gift_id IS NOT NULL
     AND sp.amount IS NOT NULL AND sp.amount > 0
     AND EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = sp.created_gift_id)
     AND NOT EXISTS (
       SELECT 1 FROM payment_applications pa
       WHERE pa.payment_id = sp.id AND pa.gift_id = sp.created_gift_id
         AND pa.link_role = 'counted' AND pa.evidence_source = 'quickbooks');

  SELECT count(*) INTO gap_group FROM staged_payments sp
   WHERE sp.group_reconciled_gift_id IS NOT NULL
     AND sp.amount IS NOT NULL AND sp.amount > 0
     AND EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = sp.group_reconciled_gift_id)
     AND NOT EXISTS (
       SELECT 1 FROM payment_applications pa
       WHERE pa.payment_id = sp.id AND pa.gift_id = sp.group_reconciled_gift_id
         AND pa.link_role = 'counted' AND pa.evidence_source = 'quickbooks');

  SELECT count(*) INTO gap_ptr FROM gifts_and_payments g
   WHERE g.final_amount_qb_staged_payment_id IS NOT NULL
     AND g.amount IS NOT NULL AND g.amount > 0
     AND EXISTS (SELECT 1 FROM staged_payments sp WHERE sp.id = g.final_amount_qb_staged_payment_id)
     AND NOT EXISTS (
       SELECT 1 FROM payment_applications pa
       WHERE pa.payment_id = g.final_amount_qb_staged_payment_id AND pa.gift_id = g.id
         AND pa.link_role = 'counted' AND pa.evidence_source = 'quickbooks');

  -- Zero/null-amount legacy links can't be represented (counted CHECK > 0).
  -- Dev has none; if prod has any, they need a hand decision BEFORE cutover.
  SELECT count(*) INTO zero_amount FROM staged_payments sp
   WHERE (sp.matched_gift_id IS NOT NULL OR sp.created_gift_id IS NOT NULL
          OR sp.group_reconciled_gift_id IS NOT NULL)
     AND (sp.amount IS NULL OR sp.amount <= 0);

  IF zero_amount > 0 THEN
    RAISE EXCEPTION
      '0120 parity gate: % legacy-linked staged rows have null/non-positive amounts and cannot be ledgered — investigate before the read cutover', zero_amount;
  END IF;

  IF gap_matched > 0 OR gap_created > 0 OR gap_group > 0 OR gap_ptr > 0 THEN
    RAISE EXCEPTION
      '0120 parity gate FAILED: matched=% created=% group=% final_amount_ptr=% legacy links still lack a counted ledger row',
      gap_matched, gap_created, gap_group, gap_ptr;
  END IF;

  RAISE NOTICE '0120 parity gate passed: every legacy gift link has a counted quickbooks ledger row.';
END $$;
