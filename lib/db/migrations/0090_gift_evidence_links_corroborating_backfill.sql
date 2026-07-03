-- Migration 0090: Fold gift_evidence_links (gel) into the payment_applications
-- (PA) ledger as link_role='corroborating' rows.
--
-- PHASE 5 (docs/reconciliation-design.md §7 step 5, §5 Decision 2). gel is the
-- FK-less M:N "corroborating, never counted" evidence table. Decision 2 folds it
-- into the unified unit↔gift ledger so there is ONE ledger, distinguishing
-- counted vs corroborating by link_role instead of by a separate table. This
-- file backfills the corroborating PA rows for every gel row that predates the
-- live dual-write. Going forward the app dual-writes them on every corroboration
-- (financialCorrections /apply) and re-homes/deletes them on gift combine.
--
-- MONEY-TOTAL-NEUTRAL: corroborating rows carry link_role='corroborating' and
-- are EXCLUDED from every counted SUM / tie / settled derivation (those filter
-- link_role='counted'). This backfill therefore cannot move a single dollar; it
-- only mirrors the existing corroboration annotations into the ledger.
--
-- WHAT IS BOOKED — exactly what the live dual-write books, so a re-run AFTER
-- dual-write has begun is a pure no-op:
--
--   Every gel row becomes one corroborating PA row, keyed by anchor:
--     gel.evidence_kind = 'qb_staged'     -> evidence_source='quickbooks',
--                                            payment_id       = gel.evidence_id
--     gel.evidence_kind = 'stripe_charge' -> evidence_source='stripe',
--                                            stripe_charge_id = gel.evidence_id
--
--   id                  = gel.id  (REUSED — mutual idempotency with the live
--                         dual-write, which also seeds PA.id from gel.id, so a
--                         gel row and its ledger twin always share one id).
--   amount_applied      = gel.sub_amount. gel is written ONLY by the corrections
--                         /apply flow, which NEVER sets sub_amount, so this is
--                         NULL for every existing row — identical to the
--                         dual-write's hard-coded NULL. The role-aware CHECK
--                         permits NULL (or > 0) for corroborating rows; a stray
--                         0/negative would (correctly) fail rather than book a
--                         bad amount.
--   match_method        = 'human'          (mirrors the dual-write)
--   link_role           = 'corroborating'  (NEVER 'counted' — the whole point)
--   lifecycle           = 'confirmed'
--   confirmed_by_user_id= gel.created_by_user_id
--   confirmed_at        = gel.created_at    (best "when confirmed" proxy for a
--                         historical row; dual-write uses now() at apply time)
--   created_the_gift    = false             (corroboration never mints a gift)
--   created_at/updated_at = gel.created_at / gel.updated_at (preserve provenance)
--
-- IDEMPOTENT / RE-RUNNABLE: each INSERT is ON CONFLICT on its per-anchor
-- CORROBORATING partial UNIQUE (link_role='corroborating') DO NOTHING, so
-- re-running -- or running after the live dual-write has already booked the twin
-- (same id, same anchor) -- never duplicates or clobbers. These corroborating
-- uniques are DISJOINT from the counted book-once uniques (both partial on
-- link_role), so a counted row and a corroborating row for the same (anchor,
-- gift) coexist without collision (intended: a faithful gel mirror). The partial
-- predicate is repeated in the ON CONFLICT target so Postgres infers the index.
--
-- The JOIN to gifts_and_payments skips any orphaned gel row so a stale link
-- cannot abort the whole load on the gift_id FK (ON DELETE RESTRICT). In
-- practice gel.gift_id is an ON DELETE CASCADE FK, so orphans should not exist;
-- the JOIN is belt-and-suspenders.
--
-- ORDERING: requires migration 0065 (payment_applications table) and the S1
-- schema change that added the corroborating partial uniques + role-aware
-- amount_applied CHECK. Apply AFTER those ship via Publish (this file only reads
-- gel + writes PA; the target columns/indexes must already exist in prod).
--
-- Apply with psql -1 (wraps the whole file in ONE transaction; do NOT add a
-- BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0090_gift_evidence_links_corroborating_backfill.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0090_gift_evidence_links_corroborating_backfill.sql   (prod)

-- Q. QuickBooks-staged corroborating link (gel 'qb_staged'). --------------------
INSERT INTO payment_applications (
  id, gift_id, amount_applied, evidence_source, payment_id,
  match_method, link_role, lifecycle, confirmed_by_user_id, confirmed_at,
  created_the_gift, created_at, updated_at
)
SELECT
  gel.id,
  gel.gift_id,
  gel.sub_amount,
  'quickbooks'::payment_application_evidence_source,
  gel.evidence_id,
  'human'::payment_application_match_method,
  'corroborating'::payment_application_link_role,
  'confirmed'::payment_application_lifecycle,
  gel.created_by_user_id,
  gel.created_at,
  false,
  gel.created_at,
  gel.updated_at
FROM gift_evidence_links gel
JOIN gifts_and_payments g ON g.id = gel.gift_id
WHERE gel.evidence_kind = 'qb_staged'
ON CONFLICT (payment_id, gift_id)
  WHERE payment_id IS NOT NULL AND link_role = 'corroborating'
  DO NOTHING;

-- S. Stripe-charge corroborating link (gel 'stripe_charge'). --------------------
INSERT INTO payment_applications (
  id, gift_id, amount_applied, evidence_source, stripe_charge_id,
  match_method, link_role, lifecycle, confirmed_by_user_id, confirmed_at,
  created_the_gift, created_at, updated_at
)
SELECT
  gel.id,
  gel.gift_id,
  gel.sub_amount,
  'stripe'::payment_application_evidence_source,
  gel.evidence_id,
  'human'::payment_application_match_method,
  'corroborating'::payment_application_link_role,
  'confirmed'::payment_application_lifecycle,
  gel.created_by_user_id,
  gel.created_at,
  false,
  gel.created_at,
  gel.updated_at
FROM gift_evidence_links gel
JOIN gifts_and_payments g ON g.id = gel.gift_id
WHERE gel.evidence_kind = 'stripe_charge'
ON CONFLICT (stripe_charge_id, gift_id)
  WHERE stripe_charge_id IS NOT NULL AND link_role = 'corroborating'
  DO NOTHING;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- Corroborating ledger row count by source (should equal the gel counts):
--   SELECT evidence_source, count(*)
--   FROM payment_applications
--   WHERE link_role = 'corroborating'
--   GROUP BY 1 ORDER BY 1;
--
--   SELECT evidence_kind, count(*) FROM gift_evidence_links GROUP BY 1 ORDER BY 1;
--
--   -- Bidirectional parity (both must return ZERO). This is exactly what
--   -- `pnpm --filter @workspace/api-server run parity:gift-evidence-links`
--   -- checks; run that against prod for the authoritative gate.
--
--   -- gel with no corroborating ledger twin:
--   SELECT gel.id
--   FROM gift_evidence_links gel
--   WHERE NOT EXISTS (
--     SELECT 1 FROM payment_applications pa
--     WHERE pa.link_role = 'corroborating' AND pa.gift_id = gel.gift_id
--       AND ((gel.evidence_kind = 'qb_staged'
--               AND pa.evidence_source = 'quickbooks'
--               AND pa.payment_id = gel.evidence_id)
--         OR (gel.evidence_kind = 'stripe_charge'
--               AND pa.evidence_source = 'stripe'
--               AND pa.stripe_charge_id = gel.evidence_id)));
--
--   -- corroborating ledger row with no gel twin:
--   SELECT pa.id
--   FROM payment_applications pa
--   WHERE pa.link_role = 'corroborating'
--     AND NOT EXISTS (
--       SELECT 1 FROM gift_evidence_links gel
--       WHERE gel.gift_id = pa.gift_id
--         AND ((pa.evidence_source = 'quickbooks'
--                 AND gel.evidence_kind = 'qb_staged'
--                 AND gel.evidence_id = pa.payment_id)
--           OR (pa.evidence_source = 'stripe'
--                 AND gel.evidence_kind = 'stripe_charge'
--                 AND gel.evidence_id = pa.stripe_charge_id)));
