-- Migration 0066: Backfill the QuickBooks cash-application ledger
-- (payment_applications) from the legacy QB linkage columns/tables.
--
-- PHASE 2 (dual-write + backfill). Reconstructs one ledger row per HISTORICAL
-- QB payment->gift booking from the pre-ledger linkage. Going forward the app
-- dual-writes these rows live; this file seeds the rows that predate dual-write.
--
--   A. staged_payments.matched_gift_id          -> 1 row (created_the_gift=false)
--                                                  (also covers a group RECONCILE
--                                                   representative, whose own
--                                                   matched_gift_id = group gift)
--   B. staged_payments.created_gift_id           -> 1 row (created_the_gift=true)
--                                                  (single mint + group MINT rep)
--   C. staged_payments.group_reconciled_gift_id  -> 1 row per MEMBER payment
--   D. staged_payment_splits                     -> 1 row per split
--                                                  (amount = sub_amount, the
--                                                   gift's gross slice)
--   E. gifts_and_payments.final_amount_qb_staged_payment_id -> supplement ONLY
--        where no (payment, gift) row already exists from A-D (never duplicates).
--
-- IDEMPOTENT / RE-RUNNABLE: every INSERT is ON CONFLICT (payment_id, gift_id)
-- DO NOTHING, so re-running -- or running AFTER live dual-write has begun --
-- never duplicates or clobbers an existing row. Statements run in file order
-- inside the single psql -1 transaction, so E's NOT EXISTS sees the rows A-D
-- inserted above it.
--
-- AMOUNT GUARD: amount_applied has a CHECK (> 0), so every source filters out
-- null / non-positive amounts (mirrors the dual-write guard
-- `if (amount && Number(amount) > 0)`). The JOIN to gifts_and_payments on every
-- source skips any orphaned pointer so a stale link can't abort the whole load
-- on the gift_id FK.
--
-- PROVENANCE: match_method mirrors the dual-write -- auto_applied AND
-- match_confirmed_at => 'system_confirmed' (a human already graduated the
-- auto-match); auto_applied alone => 'system' (worker / auto-create rule);
-- else 'human'. confirmed_by/at come from the staged row's match_confirmed_*
-- (null for unconfirmed auto rows). Splits attribute confirmed_by to the
-- split's creator.
--
-- NOTE (deliberately NOT booked): Stripe-payout confirm-replace and Donorbox
-- enrichment are NOT QB cash-applications -- per the frozen model the ledger
-- holds QB-settled money only in this phase. Those evidence sources land in a
-- later phase; this backfill is QB-only (evidence_source = 'quickbooks').
--
-- ORDERING: requires migration 0065 (payment_applications table) already
-- applied. Apply AFTER 0065.
--
-- Apply with psql -1 (it wraps the whole file in ONE transaction; do NOT add a
-- BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0066_payment_applications_backfill.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0066_payment_applications_backfill.sql   (prod)

-- A. matched_gift_id -> links to a PRE-EXISTING gift (no mint). -------------
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, confirmed_by_user_id, confirmed_at, created_the_gift,
  created_at, updated_at
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
  sp.match_confirmed_by_user_id,
  sp.match_confirmed_at,
  false,
  now(), now()
FROM staged_payments sp
JOIN gifts_and_payments g ON g.id = sp.matched_gift_id
WHERE sp.matched_gift_id IS NOT NULL
  AND sp.amount IS NOT NULL
  AND sp.amount > 0
ON CONFLICT (payment_id, gift_id) DO NOTHING;

-- B. created_gift_id -> a NEW gift was minted from this payment. ------------
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, confirmed_by_user_id, confirmed_at, created_the_gift,
  created_at, updated_at
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
  sp.match_confirmed_by_user_id,
  sp.match_confirmed_at,
  true,
  now(), now()
FROM staged_payments sp
JOIN gifts_and_payments g ON g.id = sp.created_gift_id
WHERE sp.created_gift_id IS NOT NULL
  AND sp.amount IS NOT NULL
  AND sp.amount > 0
ON CONFLICT (payment_id, gift_id) DO NOTHING;

-- C. group_reconciled_gift_id -> one row per NON-representative member. ------
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, confirmed_by_user_id, confirmed_at, created_the_gift,
  created_at, updated_at
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
  sp.match_confirmed_by_user_id,
  sp.match_confirmed_at,
  false,
  now(), now()
FROM staged_payments sp
JOIN gifts_and_payments g ON g.id = sp.group_reconciled_gift_id
WHERE sp.group_reconciled_gift_id IS NOT NULL
  AND sp.amount IS NOT NULL
  AND sp.amount > 0
ON CONFLICT (payment_id, gift_id) DO NOTHING;

-- D. staged_payment_splits -> one row per split target gift. ----------------
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, confirmed_by_user_id, confirmed_at, created_the_gift,
  created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  sps.staged_payment_id,
  sps.gift_id,
  sps.sub_amount,
  'quickbooks'::payment_application_evidence_source,
  'human'::payment_application_match_method,
  sps.created_by_user_id,
  sp.match_confirmed_at,
  false,
  now(), now()
FROM staged_payment_splits sps
JOIN staged_payments sp ON sp.id = sps.staged_payment_id
JOIN gifts_and_payments g ON g.id = sps.gift_id
WHERE sps.sub_amount IS NOT NULL
  AND sps.sub_amount > 0
ON CONFLICT (payment_id, gift_id) DO NOTHING;

-- E. Supplement from the gift's QB final-amount pointer. --------------------
-- Catches QB-stamped gifts whose staged-row link columns were cleared but whose
-- provenance pointer survives. Gated on NOT EXISTS so it never double-books a
-- pair already covered by A-D (which ran earlier in this same transaction).
INSERT INTO payment_applications (
  id, payment_id, gift_id, amount_applied, evidence_source,
  match_method, confirmed_by_user_id, confirmed_at, created_the_gift,
  created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  g.final_amount_qb_staged_payment_id,
  g.id,
  g.amount,
  'quickbooks'::payment_application_evidence_source,
  'human'::payment_application_match_method,
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
  )
ON CONFLICT (payment_id, gift_id) DO NOTHING;

-- Verification (run by hand AFTER applying) ---------------------------------
--   -- Row count + breakdown by source category:
--   SELECT created_the_gift, match_method, count(*)
--   FROM payment_applications GROUP BY 1, 2 ORDER BY 1, 2;
--
--   -- BOOK-ONCE audit: any payment whose ledger SUM exceeds its own amount by
--   -- more than a cent (no DB constraint enforces this -- inspect before T003):
--   SELECT pa.payment_id, sp.amount AS payment_amount,
--          sum(pa.amount_applied) AS applied
--   FROM payment_applications pa
--   JOIN staged_payments sp ON sp.id = pa.payment_id
--   GROUP BY pa.payment_id, sp.amount
--   HAVING sum(pa.amount_applied) > coalesce(sp.amount, 0) + 0.01
--   ORDER BY applied - sp.amount DESC;
--
--   -- PARITY spot-check: on-books gifts whose ledger SUM diverges from the
--   -- gift's stored amount (expected for amount_mismatch ties; should be empty
--   -- for cleanly QB-stamped gifts):
--   SELECT g.id, g.amount AS gift_amount, sum(pa.amount_applied) AS ledger_sum
--   FROM gifts_and_payments g
--   JOIN payment_applications pa ON pa.gift_id = g.id
--   WHERE coalesce(g.off_books_fiscal_sponsor, false) = false
--     AND coalesce(g.designated_to_school, false) = false
--   GROUP BY g.id, g.amount
--   HAVING abs(sum(pa.amount_applied) - coalesce(g.amount, 0)) > 0.01
--   ORDER BY abs(sum(pa.amount_applied) - coalesce(g.amount, 0)) DESC;
