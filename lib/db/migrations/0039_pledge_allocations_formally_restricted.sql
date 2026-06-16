-- 0039: Add formally_restricted flag to pledge_allocations.
--
-- Distinguishes an allocation that is FORMALLY restricted by the grant letter
-- from one that merely documents our understanding of the donor's intent.
-- Mirrors the gift_allocations restriction booleans at the opportunity/pledge
-- stage (a single flag is sufficient before money is in).
--
-- Idempotent: safe to run more than once. Non-destructive (additive column with
-- a NOT NULL DEFAULT false, so existing rows backfill to "not formally
-- restricted").

ALTER TABLE pledge_allocations
  ADD COLUMN IF NOT EXISTS formally_restricted boolean NOT NULL DEFAULT false;
