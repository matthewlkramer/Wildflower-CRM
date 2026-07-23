-- 0158 — Counted-uniqueness partial unique indexes (ADR linear-money-model §7 step 5).
--
-- Enforces the linear money model's core invariant at the DB layer: at most
-- ONE counted payment_applications row per evidence anchor (staged QB payment,
-- Stripe charge, Donorbox donation) — one anchor's money settles one gift.
-- The service layer throws AnchorAlreadyCountedError first (clean 409s); these
-- indexes are the backstop no code path can bypass.
--
-- The existing per-(anchor, gift) pair partial uniques REMAIN — they are the
-- ON CONFLICT arbiters applyPaymentApplication upserts through. A same-gift
-- re-apply conflicts on both indexes for the same row (DO UPDATE still fires);
-- a different-gift insert hits only the new single-column index → 23505.
--
-- Prerequisite: 0157 (recode of the historical one-unit→N-gifts clusters) has
-- been applied — every anchor already carries at most one counted row. The
-- preflight below verifies that and aborts the whole file otherwise.
--
-- Apply (human-run, from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0158_counted_uniqueness_index.sql
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS; a second run is a no-op.
-- No BEGIN/COMMIT here — psql -1 wraps the whole file in one transaction.
-- Index names/definitions match the Drizzle schema emit exactly
-- (lib/db/src/schema/paymentApplications.ts), so Publish sees no diff.

-- ═════════════════════════════════════════════════════════════════════════
-- PREFLIGHT — zero counted duplicates per anchor (else RAISE, rolling back)
-- ═════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  n_payment  int;
  n_stripe   int;
  n_donorbox int;
BEGIN
  SELECT count(*) INTO n_payment FROM (
    SELECT payment_id FROM payment_applications
     WHERE payment_id IS NOT NULL AND link_role = 'counted'
     GROUP BY payment_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO n_stripe FROM (
    SELECT stripe_charge_id FROM payment_applications
     WHERE stripe_charge_id IS NOT NULL AND link_role = 'counted'
     GROUP BY stripe_charge_id HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO n_donorbox FROM (
    SELECT donorbox_donation_id FROM payment_applications
     WHERE donorbox_donation_id IS NOT NULL AND link_role = 'counted'
     GROUP BY donorbox_donation_id HAVING count(*) > 1
  ) d;

  IF n_payment > 0 OR n_stripe > 0 OR n_donorbox > 0 THEN
    RAISE EXCEPTION
      '0158 preflight failed: counted duplicates remain (payment_id: %, stripe_charge_id: %, donorbox_donation_id: %). Apply/repair 0157 first.',
      n_payment, n_stripe, n_donorbox;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- INDEXES — names + predicates exactly as Drizzle emits them
-- ═════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "payment_applications_payment_id_counted_uq"
  ON "payment_applications" USING btree ("payment_id")
  WHERE "payment_applications"."payment_id" IS NOT NULL
    AND "payment_applications"."link_role" = 'counted';

CREATE UNIQUE INDEX IF NOT EXISTS "payment_applications_stripe_charge_id_counted_uq"
  ON "payment_applications" USING btree ("stripe_charge_id")
  WHERE "payment_applications"."stripe_charge_id" IS NOT NULL
    AND "payment_applications"."link_role" = 'counted';

CREATE UNIQUE INDEX IF NOT EXISTS "payment_applications_donorbox_donation_id_counted_uq"
  ON "payment_applications" USING btree ("donorbox_donation_id")
  WHERE "payment_applications"."donorbox_donation_id" IS NOT NULL
    AND "payment_applications"."link_role" = 'counted';
