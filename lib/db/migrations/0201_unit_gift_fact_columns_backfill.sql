-- 0201: move the per-tie facts of the counted payment_applications row onto
-- payment_units (docs/adr-unit-gift-pointer.md — write retirement, step 1).
--
-- The counted-unique index guarantees at most one counted ledger row per
-- unit, so each of these is a scalar per-unit fact:
--   gift_allocation_id       narrowing pointer to the allocation the reviewer
--                            chose (NULL = header-level, the default)
--   gift_match_method        how the unit→gift tie was made
--   gift_confirmed_by_user_id / gift_confirmed_at   who/when confirmed it
--   gift_note                human note carried on the tie
--   created_the_gift         TRUE when booking this unit MINTED the gift
--
-- amount_applied deliberately does NOT move: gross-vs-net booking is a
-- QBO/accounting-plane fact (owner ruling), not a unit→gift identity fact.
--
-- Additive + idempotent. Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0201_unit_gift_fact_columns_backfill.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TABLE payment_units
  ADD COLUMN IF NOT EXISTS gift_allocation_id text
    REFERENCES gift_allocations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gift_match_method payment_application_match_method,
  ADD COLUMN IF NOT EXISTS gift_confirmed_by_user_id text
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gift_confirmed_at timestamp,
  ADD COLUMN IF NOT EXISTS gift_note text,
  ADD COLUMN IF NOT EXISTS created_the_gift boolean NOT NULL DEFAULT false;

-- NOTE: no tie-shape CHECK here — ledger-era writers (live until the code
-- cutover publishes) set/clear gift_id without touching the fact columns.
-- The tied-unit shape constraint ships with the retirement drop (0195 era),
-- after every writer maintains the facts.

CREATE INDEX IF NOT EXISTS payment_units_gift_allocation_id_idx
  ON payment_units (gift_allocation_id);

-- Backfill from the counted ledger rows (the write authority until the code
-- cutover ships).
UPDATE payment_units pu
SET gift_allocation_id      = pa.gift_allocation_id,
    gift_match_method       = pa.match_method,
    gift_confirmed_by_user_id = pa.confirmed_by_user_id,
    gift_confirmed_at       = pa.confirmed_at,
    gift_note               = pa.note,
    created_the_gift        = pa.created_the_gift,
    updated_at              = now()
FROM payment_applications pa
WHERE pa.payment_unit_id = pu.id
  AND pa.link_role = 'counted'
  AND pu.gift_id = pa.gift_id
  AND (pu.gift_allocation_id       IS DISTINCT FROM pa.gift_allocation_id
    OR pu.gift_match_method        IS DISTINCT FROM pa.match_method
    OR pu.gift_confirmed_by_user_id IS DISTINCT FROM pa.confirmed_by_user_id
    OR pu.gift_confirmed_at        IS DISTINCT FROM pa.confirmed_at
    OR pu.gift_note                IS DISTINCT FROM pa.note
    OR pu.created_the_gift         IS DISTINCT FROM pa.created_the_gift);

DO $$
DECLARE bad int;
BEGIN
  SELECT COUNT(*) INTO bad
  FROM payment_applications pa
  JOIN payment_units pu ON pu.id = pa.payment_unit_id
  WHERE pa.link_role = 'counted'
    AND (pu.gift_id IS DISTINCT FROM pa.gift_id
      OR pu.gift_match_method IS DISTINCT FROM pa.match_method
      OR pu.created_the_gift IS DISTINCT FROM pa.created_the_gift);
  IF bad > 0 THEN
    RAISE EXCEPTION '0201: % counted ledger rows disagree with unit facts', bad;
  END IF;
END $$;
