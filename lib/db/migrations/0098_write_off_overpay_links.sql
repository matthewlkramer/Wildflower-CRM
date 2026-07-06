-- Migration 0098: write-off (pledge) + overpay (gift) resolution links.
--
-- WHY:
--   Gift/pledge booking-lifecycle & audit-close model
--   (.agents/memory/gift-booking-lifecycle-audit-close.md). Once a fiscal year's
--   external audit closes, the audited ledger facts (amounts, dates, allocations)
--   are FROZEN and CANNOT change. So a post-close correction can never be an
--   in-place edit of the audited row — it must become a NEW linked record in the
--   current OPEN fiscal year:
--     * Post-close UNDER-payment on a written pledge -> a brand-new offsetting
--       WRITE-OFF pledge (is_write_off=true) in the open FY, linked back to the
--       original via write_off_of_pledge_id, carrying NEGATIVE allocations that sum
--       to the uncollected remainder. The two pledges net to zero across years; the
--       original is NEVER mutated and reads "resolved" because a linked write-off
--       exists.
--     * Post-close OVER-payment on a gift -> a NEW surplus gift in the open FY,
--       linked back to the original via overpay_of_gift_id. The original stays
--       amount_mismatch forever, so the worklist/checklist "resolved" test keys off
--       the PRESENCE of an active linked overpay gift.
--
-- WHAT THIS FILE DOES (all idempotent, purely ADDITIVE — nothing dropped):
--   1. opportunities_and_pledges.is_write_off boolean NOT NULL DEFAULT false.
--   2. opportunities_and_pledges.write_off_of_pledge_id text FK -> self
--      (ON DELETE RESTRICT: the write-off's link back to the audited original is
--      load-bearing; the original is frozen and must not be deletable out from
--      under it) + a PARTIAL UNIQUE index enforcing AT MOST ONE active (non-archived)
--      write-off per original pledge (the real double-write-off guard, not app logic).
--   3. gifts_and_payments.overpay_of_gift_id text FK -> self (ON DELETE RESTRICT)
--      + a PARTIAL UNIQUE index enforcing at most one active overpay gift per
--      original + a plain lookup index.
--
--   These columns + FKs + indexes also reach prod via the normal Publish (drizzle)
--   diff; the IF NOT EXISTS / guarded-constraint form is the self-contained
--   idempotent equivalent so this file can run before OR after Publish with the
--   same result (mirrors 0092's pattern, invariant #7).
--
-- IDEMPOTENCY / SAFETY: re-running is a no-op (ADD COLUMN / CREATE INDEX are IF NOT
--   EXISTS; the FKs are guard-created, duplicate_object swallowed). NOTHING is
--   dropped and there is NO data backfill (these links are only ever written going
--   forward by the write-off / resolve-overpay endpoints).
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0098_write_off_overpay_links.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. opportunities_and_pledges.is_write_off ─────────────────────────────
ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS is_write_off boolean NOT NULL DEFAULT false;

-- ─── 2. opportunities_and_pledges.write_off_of_pledge_id + FK + unique idx ──
ALTER TABLE opportunities_and_pledges
  ADD COLUMN IF NOT EXISTS write_off_of_pledge_id text;

DO $$
BEGIN
  ALTER TABLE opportunities_and_pledges
    ADD CONSTRAINT opportunities_and_pledges_write_off_of_pledge_id_fk
    FOREIGN KEY (write_off_of_pledge_id) REFERENCES opportunities_and_pledges (id)
    ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- At most one ACTIVE (non-archived) write-off pledge per original pledge.
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_and_pledges_active_write_off_uq
  ON opportunities_and_pledges (write_off_of_pledge_id)
  WHERE write_off_of_pledge_id IS NOT NULL AND archived_at IS NULL;

-- ─── 3. gifts_and_payments.overpay_of_gift_id + FK + indexes ───────────────
ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS overpay_of_gift_id text;

DO $$
BEGIN
  ALTER TABLE gifts_and_payments
    ADD CONSTRAINT gifts_and_payments_overpay_of_gift_id_fk
    FOREIGN KEY (overpay_of_gift_id) REFERENCES gifts_and_payments (id)
    ON DELETE RESTRICT;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- At most one ACTIVE (non-archived) surplus gift per original gift.
CREATE UNIQUE INDEX IF NOT EXISTS gifts_and_payments_active_overpay_uq
  ON gifts_and_payments (overpay_of_gift_id)
  WHERE overpay_of_gift_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS gifts_and_payments_overpay_of_gift_id_idx
  ON gifts_and_payments (overpay_of_gift_id);

-- ─── 4. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_wo int;
  n_op int;
BEGIN
  SELECT count(*) INTO n_wo FROM opportunities_and_pledges WHERE is_write_off = true;
  SELECT count(*) INTO n_op FROM gifts_and_payments WHERE overpay_of_gift_id IS NOT NULL;
  RAISE NOTICE '0098: write-off pledges = %, overpay gifts = %', n_wo, n_op;
END $$;
