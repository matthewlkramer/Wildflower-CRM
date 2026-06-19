-- Migration 0048: Remove the premature William Penn FY27 installment
--
-- The pledge "FY26 William Penn grant" (recZRA7dsk2g2CQAp, awarded $478,250) was
-- imported from Airtable with BOTH installments already booked as received
-- pledge_payments in gifts_and_payments:
--
--   recuBzTJBnXg2nNNX  FY26  $223,500.00  2025-09-19  (real cash, QuickBooks-backed)
--   recT6GdHbEEhvI4dq  FY27  $254,750.00  2025-09-22  (NOT YET COLLECTED, no QB cash)
--
-- The FY27 row is money that has not arrived (FY27 starts Jul 2026). Booking it as
-- a received payment (a) overstates received revenue by $254,750 and (b) makes the
-- pledge derive to status='cash_in' (fully collected) when only ~47% is in. The
-- pledge's awarded_amount ($478,250) already captures the full commitment, so the
-- correct model is: keep ONE real payment ($223,500) and let the pledge carry the
-- $254,750 as an outstanding balance until William Penn actually pays it (at which
-- point it will arrive via QuickBooks and be matched/minted normally).
--
-- This is the ONLY pledge_payment in the database booked for a future fiscal year
-- (verified by sweep), so this migration is intentionally scoped to the one row.
--
-- WHY DELETE (not archive): paid_amount in deriveOppFields/applyDerivedOppFields
-- (pledgeStage.ts) SUMs ALL linked payments INCLUDING archived_at rows, so an
-- archive would NOT correct the cash_in derivation. The row must be truly removed.
--
-- The FY27 gift is NOT linked to QuickBooks (zero inbound staged_payments refs),
-- has no staged_payment_splits, and is not referenced by any gift's
-- gift_being_matched_id, so deleting it cannot desync a financial record. Its only
-- child is one synthetic default allocation (gift_allocations is RESTRICT), cleared
-- first below.
--
-- SAFETY / IDEMPOTENCY:
--   * One transaction; apply with ON_ERROR_STOP so a partial apply aborts.
--   * Step 0 locks the target gift FOR UPDATE, so no concurrent insert can add a
--     child/ref between the guard check and the delete (FK child inserts need a
--     FOR KEY SHARE lock on this row, which FOR UPDATE blocks). Same pattern as the
--     entity-merge cascade-delete lock.
--   * BOTH the allocation delete and the gift delete carry the SAME safety guard
--     (not QB/staged-linked, no splits, not referenced by gift_being_matched_id),
--     so they fire together or not at all — never a half-applied state.
--   * Step 3 re-derives off the LIVE remaining SUM and fully mirrors deriveOppFields
--     (incl. advancing stage written_commitment -> cash_in when fully paid), so a
--     re-run is a no-op and stays correct if WP later pays the FY27 balance.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0048_fix_william_penn_premature_fy27_payment.sql

BEGIN;

-- Step 0 — lock the target gift so no concurrent FK-child insert (allocation,
-- split, or staged-payment match) can sneak in between the guard and the delete.
SELECT id
  FROM gifts_and_payments
 WHERE id = 'recT6GdHbEEhvI4dq'
   FOR UPDATE;

-- Step 1 — drop the synthetic default allocation (gift_allocations.gift_id is
-- RESTRICT, so it must go before the gift row). Guarded by the SAME predicate as
-- the gift delete (Step 2) so the two always stay consistent.
DELETE FROM gift_allocations
 WHERE gift_id = 'recT6GdHbEEhvI4dq'
   AND EXISTS (
     SELECT 1 FROM gifts_and_payments g
      WHERE g.id = 'recT6GdHbEEhvI4dq'
        AND g.payment_on_pledge_id = 'recZRA7dsk2g2CQAp'
        AND NOT EXISTS (SELECT 1 FROM staged_payments s
                         WHERE s.matched_gift_id = g.id
                            OR s.created_gift_id = g.id
                            OR s.group_reconciled_gift_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM staged_payment_splits sp WHERE sp.gift_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM gifts_and_payments gm WHERE gm.gift_being_matched_id = g.id)
   );

-- Step 2 — delete the premature FY27 pledge_payment ($254,750). Same guard: never
-- delete a QB/staged-linked row, one with splits, or one another gift is matching
-- against. (All inbound FKs are accounted for: gift_allocations + staged_payment_splits
-- are RESTRICT and handled; the rest are SET NULL and guarded here.)
DELETE FROM gifts_and_payments g
 WHERE g.id = 'recT6GdHbEEhvI4dq'
   AND g.payment_on_pledge_id = 'recZRA7dsk2g2CQAp'
   AND NOT EXISTS (SELECT 1 FROM staged_payments s
                    WHERE s.matched_gift_id = g.id
                       OR s.created_gift_id = g.id
                       OR s.group_reconciled_gift_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM staged_payment_splits sp WHERE sp.gift_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM gifts_and_payments gm WHERE gm.gift_being_matched_id = g.id);

-- Step 3 — re-derive the pledge's persisted status/stage/win_probability from the
-- REMAINING payments, fully mirroring deriveOppFields (loss_type IS NULL):
--     awarded>0 AND paid>=awarded   -> status cash_in, win_prob 1.0000,
--                                      stage written_commitment -> cash_in
--     else stage=written_commitment -> status pledge,  win_prob 0.9000
--     else                          -> status open
-- A raw SQL delete does not re-run the server-side derivation, so we apply it here.
-- After Step 2: paid 223,500 < awarded 478,250 -> status pledge, stage stays
-- written_commitment, win_prob 0.9000. Self-correcting + idempotent (keyed off SUM).
-- NB: every SET expression reads the row's PRE-update column values (Postgres), so
-- the stage/win_probability CASEs see the OLD stage — intended.
WITH paid AS (
  SELECT COALESCE(SUM(amount), 0) AS total
    FROM gifts_and_payments
   WHERE payment_on_pledge_id = 'recZRA7dsk2g2CQAp'
)
UPDATE opportunities_and_pledges o
   SET status = CASE
                  WHEN o.awarded_amount > 0 AND (SELECT total FROM paid) >= o.awarded_amount
                    THEN 'cash_in'::opportunity_status
                  WHEN o.stage = 'written_commitment'
                    THEN 'pledge'::opportunity_status
                  ELSE 'open'::opportunity_status
                END,
       stage = CASE
                  WHEN o.awarded_amount > 0 AND (SELECT total FROM paid) >= o.awarded_amount
                       AND o.stage = 'written_commitment'
                    THEN 'cash_in'::opportunity_stage
                  ELSE o.stage
                END,
       win_probability = CASE
                  WHEN o.awarded_amount > 0 AND (SELECT total FROM paid) >= o.awarded_amount
                    THEN 1.0000
                  WHEN o.stage = 'written_commitment'
                    THEN 0.9000
                  ELSE o.win_probability
                END,
       updated_at = now()
 WHERE o.id = 'recZRA7dsk2g2CQAp';

-- Verification (run after COMMIT):
--   -- gift is gone (expect 0):
--   SELECT count(*) FROM gifts_and_payments WHERE id = 'recT6GdHbEEhvI4dq';
--   -- pledge re-derived (expect status=pledge, stage=written_commitment,
--   -- win_probability=0.9000, paid=223500.00, outstanding=254750.00):
--   SELECT o.id, o.status::text, o.stage::text, o.win_probability, o.awarded_amount,
--          (SELECT COALESCE(SUM(amount),0) FROM gifts_and_payments
--             WHERE payment_on_pledge_id = o.id) AS paid,
--          o.awarded_amount - (SELECT COALESCE(SUM(amount),0) FROM gifts_and_payments
--             WHERE payment_on_pledge_id = o.id) AS outstanding
--     FROM opportunities_and_pledges o WHERE o.id = 'recZRA7dsk2g2CQAp';

COMMIT;
