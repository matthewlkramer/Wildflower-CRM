-- 0103_backfill_offbooks_to_allocation_entities.sql
--
-- DATA-ONLY production backfill (Task #594). The three legacy header booleans on
-- gifts_and_payments — designated_to_school / off_books_fiscal_sponsor /
-- payment_expected — are being RETIRED. Off-books / payment-exempt now derives
-- ONLY from the allocation entities: a gift is off-books exactly when it has >=1
-- allocation AND EVERY allocation sits on a no-payment entity
-- (entities.expects_payment = false) — "Direct to School" (direct_to_school) or
-- "Wildflower Foundation TSNE" (wildflower_foundation_tsne). This mirrors
-- giftIsOffBooksExpr() in artifacts/api-server/src/lib/giftPaymentSummary.ts.
--
-- WHY: the currently-deployed code OR's the header flags INTO the off-books
-- derivation. The new build (this task) drops those OR terms, so any gift that is
-- off-books today ONLY because of a header flag would silently FLIP to on-books
-- (pulled into the settled-vs-entered reconciliation queue, QB-tie demanded) the
-- moment the new code goes live. This backfill repoints those gifts' allocations
-- onto the matching no-payment entity so the allocation-only derivation keeps them
-- off-books — ZERO flips.
--
-- VERIFIED read-only against BOTH dev and prod before writing this file:
--   * designated_to_school = TRUE on 49 gifts (dev AND prod); off_books_fiscal_sponsor
--     and payment_expected = false are BOTH 0 rows in dev AND prod.
--   * every one of those 49 gifts has >=1 allocation and ALL of their allocations
--     sit on entity 'wildflower_foundation' (expects_payment = TRUE) — i.e. under
--     the new allocation-only rule they would ALL flip on-books without this file.
--   * prod already has both no-payment entity rows (direct_to_school,
--     wildflower_foundation_tsne, expects_payment = false); DEV HAS NEITHER, so
--     step 1 seeds them idempotently (a no-op in prod, creates them in dev) — the
--     repoint FK in step 2/3 would fail in dev otherwise.
--
-- BOOKING DECISION (confirmed with the product owner): the 49 designated-to-school
-- gifts are true pass-through money and STAY off-books, booked onto the
-- direct_to_school no-payment entity. This is deliberately DISTINCT from an
-- allocation's school_recipient_id sitting on the wildflower_foundation entity
-- (money WF received then passed to a school, which still expects a payment and
-- stays on-books) — those rows are NOT touched here (school restriction is an
-- independent on-books concept carried by school_recipient_id).
--
-- IDEMPOTENT: entity seed uses ON CONFLICT DO NOTHING; each repoint is guarded by
-- entity_id IS DISTINCT FROM the target, so a re-run after a successful apply is a
-- no-op. NON-DESTRUCTIVE: no DELETEs; only allocation entity_id is repointed for
-- header-flagged off-books gifts. The final guard ABORTS (rolls back the whole
-- file) if ANY gift would still flip off-books -> on-books.
--
-- ORDERING: apply this file to prod (and dev) BEFORE 0104 drops the columns (this
-- file still READS the header columns) and BEFORE/at the same window as the
-- Publish of this task's read-stop code. Applying it BEFORE the new code goes live
-- is safe: the old code already treats no-payment-entity allocations as off-books,
-- so repointing changes nothing for the old build while pre-positioning the new
-- one. Apply to prod AND dev; do NOT Publish in between prod-only and dev.
--
-- Applied by a human (the agent cannot write prod), from the repo root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0103_backfill_offbooks_to_allocation_entities.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0103_backfill_offbooks_to_allocation_entities.sql   (dev)
--
-- NOTE: no BEGIN/COMMIT here — psql -1 wraps the whole file in one transaction.

-- ──────────────────────────────────────────────────────────────────────────
-- Pre-state (for the operator).
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n_designated int;
  n_offbooks   int;
  n_notexpect  int;
BEGIN
  SELECT count(*) INTO n_designated FROM gifts_and_payments WHERE designated_to_school;
  SELECT count(*) INTO n_offbooks   FROM gifts_and_payments WHERE off_books_fiscal_sponsor;
  SELECT count(*) INTO n_notexpect  FROM gifts_and_payments WHERE payment_expected = false;
  RAISE NOTICE '0103 PRE: designated_to_school = % (expect 49) | off_books_fiscal_sponsor = % (expect 0) | payment_expected=false = % (expect 0)',
    n_designated, n_offbooks, n_notexpect;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- Step 1: ensure the two no-payment entities exist (idempotent). Prod already
-- has both; dev has neither. Without these rows the repoint FK below fails.
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO entities (id, name, expects_payment, active, created_at, updated_at)
VALUES
  ('direct_to_school',            'Direct to School',           false, true, now(), now()),
  ('wildflower_foundation_tsne',  'Wildflower Foundation TSNE', false, true, now(), now())
ON CONFLICT (id) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- Step 2: repoint EVERY allocation of a designated-to-school gift onto the
-- direct_to_school no-payment entity, so all of its allocations are off-books.
-- (All 49 currently sit on wildflower_foundation; the IS DISTINCT FROM guard
-- makes a re-run a no-op and also catches any NULL/other-entity allocation.)
-- ══════════════════════════════════════════════════════════════════════════
UPDATE gift_allocations ga
   SET entity_id  = 'direct_to_school',
       updated_at = now()
  FROM gifts_and_payments g
 WHERE ga.gift_id = g.id
   AND g.designated_to_school = true
   AND ga.entity_id IS DISTINCT FROM 'direct_to_school';

-- ══════════════════════════════════════════════════════════════════════════
-- Step 3: repoint EVERY allocation of a fiscal-sponsor / not-payment-expected
-- gift (that is NOT designated) onto the wildflower_foundation_tsne no-payment
-- entity. ZERO rows in dev AND prod today, but kept for completeness so the
-- retirement is correct even if such a row is created before this is applied.
-- ══════════════════════════════════════════════════════════════════════════
UPDATE gift_allocations ga
   SET entity_id  = 'wildflower_foundation_tsne',
       updated_at = now()
  FROM gifts_and_payments g
 WHERE ga.gift_id = g.id
   AND g.designated_to_school = false
   AND (g.off_books_fiscal_sponsor = true OR g.payment_expected = false)
   AND ga.entity_id IS DISTINCT FROM 'wildflower_foundation_tsne';

-- ══════════════════════════════════════════════════════════════════════════
-- Step 4: GUARD — prove ZERO off-books -> on-books flips. Every gift that is
-- off-books under the OLD header-OR semantics (designated OR off_books_fs OR NOT
-- payment_expected) must still be off-books under the NEW allocation-only rule
-- (has >=1 allocation AND no allocation with a NULL entity or a payment-bearing
-- entity — mirrors giftIsOffBooksExpr exactly). Aborts (rolls back) otherwise.
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  flipped int;
BEGIN
  SELECT count(*) INTO flipped
    FROM gifts_and_payments g
   WHERE (g.designated_to_school
          OR g.off_books_fiscal_sponsor
          OR g.payment_expected = false)
     AND NOT (
       EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id)
       AND NOT EXISTS (
         SELECT 1
           FROM gift_allocations ga
           LEFT JOIN entities e ON e.id = ga.entity_id
          WHERE ga.gift_id = g.id
            AND (ga.entity_id IS NULL OR COALESCE(e.expects_payment, true) = true)
       )
     );
  IF flipped > 0 THEN
    RAISE EXCEPTION '0103 ABORT: % header-off-books gift(s) would flip to ON-books under the allocation-only rule — backfill incomplete, transaction rolled back', flipped;
  END IF;
  RAISE NOTICE '0103 OK: no off-books -> on-books flips (guard passed)';
END $$;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- Both no-payment entities present:
--   SELECT id, expects_payment FROM entities WHERE expects_payment = false ORDER BY id;
--   -- Every designated gift's allocations now on a no-payment entity (expect all
--   -- direct_to_school, none on a payment-bearing entity):
--   SELECT ga.entity_id, count(*) FROM gifts_and_payments g
--     JOIN gift_allocations ga ON ga.gift_id = g.id
--    WHERE g.designated_to_school GROUP BY 1 ORDER BY 1;
