-- Migration 0086: Backfill the Stripe + Donorbox cash-application ledger rows
-- (payment_applications) from the legacy per-processor gift-link columns.
--
-- PHASE 2 (dual-write + backfill), the Stripe/Donorbox half. Migration 0066
-- seeded the QuickBooks rows (evidence_source='quickbooks'); this file seeds the
-- Stripe (evidence_source='stripe') and Donorbox (evidence_source='donorbox')
-- rows that predate their live dual-write. Going forward the app dual-writes
-- these rows on every settle / mint / link (bookStripeChargeApplication /
-- bookDonorboxDonationApplication).
--
-- WHAT IS BOOKED — exactly what the live dual-write books, so a re-run AFTER
-- dual-write has begun is a pure no-op:
--
--   STRIPE (stripe_staged_charges):
--     Every charge with a settled gift pointer — matched_gift_id (linked to a
--     PRE-EXISTING gift; also the QB-anchored reconcile + worker auto-apply case)
--     OR created_gift_id (a NEW gift minted from the charge). A charge settles at
--     most ONE gift and always nulls the other pointer, so COALESCE picks it and
--     created_the_gift = (created_gift_id IS NOT NULL). A revert clears BOTH
--     pointers, so a non-null pointer == currently settled. amount = gross_amount
--     (donors are credited the GROSS). match_method mirrors the dual-write:
--     auto_applied => 'system' (worker), else 'human' (every reconcile path sets
--     auto_applied=false). Stripe auto-apply is terminal-until-revert with no
--     confirm-promotion, so 'system_confirmed' is intentionally unreachable here.
--
--   DONORBOX (donorbox_donations):
--     Every donation with matched_gift_id (human link -> PRE-EXISTING gift) OR
--     created_gift_id (human mint -> NEW gift). These pointers are set ONLY by the
--     two human review routes (link-gift / create-gift); the sync's enrichment and
--     suggested-donor paths NEVER set a gift link, so this correctly EXCLUDES
--     enrich-only Stripe-type donations (which enrich the existing Stripe gift, not
--     the donation row). Donorbox never auto-applies, so match_method is always
--     'human'. amount = amount. created_the_gift = (created_gift_id IS NOT NULL).
--
-- IDEMPOTENT / RE-RUNNABLE: every INSERT is ON CONFLICT (per-anchor partial
-- UNIQUE) DO NOTHING, so re-running -- or running after live dual-write -- never
-- duplicates or clobbers an existing row. The partial-index predicate
-- (<anchor> IS NOT NULL) is repeated in the ON CONFLICT target so Postgres can
-- infer the partial unique index.
--
-- AMOUNT GUARD: amount_applied has a CHECK (> 0), so each source filters out
-- null / non-positive amounts (mirrors the dual-write `if (amount > 0)` no-op).
-- The JOIN to gifts_and_payments skips any orphaned pointer so a stale link can't
-- abort the whole load on the gift_id FK (ON DELETE RESTRICT).
--
-- link_role ('counted') and lifecycle ('confirmed') are left to their column
-- defaults, exactly as the dual-write helper does.
--
-- PARALLEL EVIDENCE (not a conflict): a gift settled by BOTH a QB payment and a
-- Stripe charge gets one 'quickbooks' row (0066) AND one 'stripe' row (here) --
-- different anchors, different per-anchor unique keys, different rows. The
-- per-gift derivations read one evidence_source at a time, so they never sum
-- across sources; this backfill does not (and must not) dedupe across sources.
--
-- ORDERING: requires migration 0065 (payment_applications table). Independent of
-- 0066 (different evidence_source), but conventionally applied after it.
--
-- Apply with psql -1 (wraps the whole file in ONE transaction; do NOT add a
-- BEGIN/COMMIT here or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0086_payment_applications_stripe_donorbox_backfill.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0086_payment_applications_stripe_donorbox_backfill.sql   (prod)

-- S. Stripe charge -> gift. matched_gift_id OR created_gift_id (settled). -----
INSERT INTO payment_applications (
  id, gift_id, amount_applied, evidence_source, stripe_charge_id,
  match_method, confirmed_by_user_id, confirmed_at, created_the_gift,
  created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  COALESCE(sc.matched_gift_id, sc.created_gift_id),
  sc.gross_amount,
  'stripe'::payment_application_evidence_source,
  sc.id,
  (CASE WHEN sc.auto_applied THEN 'system' ELSE 'human' END)
    ::payment_application_match_method,
  sc.match_confirmed_by_user_id,
  sc.match_confirmed_at,
  (sc.created_gift_id IS NOT NULL),
  now(), now()
FROM stripe_staged_charges sc
JOIN gifts_and_payments g
  ON g.id = COALESCE(sc.matched_gift_id, sc.created_gift_id)
WHERE (sc.matched_gift_id IS NOT NULL OR sc.created_gift_id IS NOT NULL)
  AND sc.gross_amount IS NOT NULL
  AND sc.gross_amount > 0
ON CONFLICT (stripe_charge_id, gift_id)
  WHERE stripe_charge_id IS NOT NULL
  DO NOTHING;

-- D. Donorbox donation -> gift. matched_gift_id OR created_gift_id (human). ---
INSERT INTO payment_applications (
  id, gift_id, amount_applied, evidence_source, donorbox_donation_id,
  match_method, confirmed_by_user_id, confirmed_at, created_the_gift,
  created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  COALESCE(dd.matched_gift_id, dd.created_gift_id),
  dd.amount,
  'donorbox'::payment_application_evidence_source,
  dd.id,
  'human'::payment_application_match_method,
  dd.match_confirmed_by_user_id,
  dd.match_confirmed_at,
  (dd.created_gift_id IS NOT NULL),
  now(), now()
FROM donorbox_donations dd
JOIN gifts_and_payments g
  ON g.id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
WHERE (dd.matched_gift_id IS NOT NULL OR dd.created_gift_id IS NOT NULL)
  AND dd.amount IS NOT NULL
  AND dd.amount > 0
ON CONFLICT (donorbox_donation_id, gift_id)
  WHERE donorbox_donation_id IS NOT NULL
  DO NOTHING;

-- Verification (run by hand AFTER applying) ---------------------------------
--   -- Row count by source (quickbooks from 0066; stripe/donorbox from here):
--   SELECT evidence_source, created_the_gift, match_method, count(*)
--   FROM payment_applications GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
--
--   -- STRIPE parity: every settled charge has exactly one ledger row, and no
--   -- ledger row lacks its legacy pointer (should both be empty).
--   SELECT sc.id
--   FROM stripe_staged_charges sc
--   JOIN gifts_and_payments g
--     ON g.id = COALESCE(sc.matched_gift_id, sc.created_gift_id)
--   WHERE (sc.matched_gift_id IS NOT NULL OR sc.created_gift_id IS NOT NULL)
--     AND sc.gross_amount > 0
--     AND NOT EXISTS (
--       SELECT 1 FROM payment_applications pa
--       WHERE pa.stripe_charge_id = sc.id
--         AND pa.gift_id = COALESCE(sc.matched_gift_id, sc.created_gift_id)
--     );
--
--   -- DONORBOX parity: same shape for the two human review routes.
--   SELECT dd.id
--   FROM donorbox_donations dd
--   JOIN gifts_and_payments g
--     ON g.id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
--   WHERE (dd.matched_gift_id IS NOT NULL OR dd.created_gift_id IS NOT NULL)
--     AND dd.amount > 0
--     AND NOT EXISTS (
--       SELECT 1 FROM payment_applications pa
--       WHERE pa.donorbox_donation_id = dd.id
--         AND pa.gift_id = COALESCE(dd.matched_gift_id, dd.created_gift_id)
--     );
