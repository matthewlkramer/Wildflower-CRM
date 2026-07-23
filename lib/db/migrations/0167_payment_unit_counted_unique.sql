-- 0167: Phase 9a — collapse counted-uniqueness onto the payment-unit anchor
-- (docs/adr-bank-spine-money-model.md). The three per-source counted uniques
-- (0158) said "one counted row per QB payment / Stripe charge / Donorbox
-- donation"; this says the end-state invariant directly: at most ONE counted
-- ledger row per CANONICAL PAYMENT UNIT — one real payment settles one gift.
--
-- Two legacy counted rows can describe the same unit (an offline check entered
-- in both QBO and Donorbox → a quickbooks row AND a donorbox row). This file:
--   1. CONSOLIDATES same-(unit, gift) duplicate counted rows — keeps ONE per
--      unit, deterministically (source priority stripe → quickbooks →
--      donorbox, then oldest), deletes the rest. Same gift + same unit means
--      the duplicates are two descriptions of the SAME booking, so deleting
--      the extras changes no gift's settled total.
--   2. PREFLIGHTS the remaining groups: a unit counted toward TWO DIFFERENT
--      gifts is real double-counted money — never auto-resolved; the file
--      RAISEs (rolling back) and a human fixes the rows first (parity runbook
--      G7 lists them).
--   3. Creates the single counted-unique partial index on payment_unit_id.
--      The three per-source uniques REMAIN (they are the ON CONFLICT arbiters
--      and constrain rows whose unit is still NULL); they demote/retire with
--      the source anchors at the final rename step.
--
-- The 0164/0165 dry-run and PROD apply both showed ZERO duplicate groups, so
-- steps 1–2 are expected no-ops — they exist so this file is safe on any data.
--
-- WHY SAFE: the only destructive step (1) deletes provably redundant rows
-- (same unit + same gift + counted), keeping one; totals per gift are
-- unchanged. Idempotent: re-runs find no duplicates and the index exists.
--
-- Run (human, repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0167_payment_unit_counted_unique.sql

-- 1. Consolidate same-(unit, gift) duplicate counted rows.
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY payment_unit_id, gift_id
      ORDER BY
        CASE evidence_source
          WHEN 'stripe' THEN 1
          WHEN 'quickbooks' THEN 2
          ELSE 3
        END,
        created_at, id
    ) AS rn
  FROM payment_applications
  WHERE payment_unit_id IS NOT NULL AND link_role = 'counted'
)
DELETE FROM payment_applications pa
USING ranked r
WHERE pa.id = r.id AND r.rn > 1;

-- 2. Preflight: any unit still counted toward >1 gift is REAL double-counted
--    money — abort for a human (parity runbook G7).
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT payment_unit_id FROM payment_applications
     WHERE payment_unit_id IS NOT NULL AND link_role = 'counted'
     GROUP BY payment_unit_id HAVING count(*) > 1
  ) d;
  IF n > 0 THEN
    RAISE EXCEPTION
      '0167 aborted: % payment unit(s) carry counted rows for MULTIPLE gifts — double-counted money that must be resolved by a human first (see bank_spine_PARITY_RUNBOOK.md G7)', n;
  END IF;
END $$;

-- 3. The end-state counted-unique: one counted row per canonical unit.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_applications_payment_unit_id_counted_uq"
  ON payment_applications (payment_unit_id)
  WHERE payment_unit_id IS NOT NULL AND link_role = 'counted';
