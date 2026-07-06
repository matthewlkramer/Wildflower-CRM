-- Migration 0103: Add bookable-gift capture columns to gifts_and_payments
--
-- Task #585 (bookable-gift SOP & incomplete-gift queue) adds two capture fields
-- on the gift header:
--
--   awaiting_settlement  — boolean, NOT NULL DEFAULT false. Set true when a gift
--                          is minted from an opportunity that is about to settle
--                          ("won gift awaiting imminent payment"). While true the
--                          fresh, cash-tie-less gift is NOT treated as a
--                          reconciliation error (excluded from the gifts-missing-QB
--                          queue) during the brief window before its payment lands.
--
--   source_record_url    — nullable text. A link to the online source record the
--                          money came from (e.g. a Donorbox donation). Serves as
--                          restriction evidence: a donor_restricted gift is bookable
--                          when it has EITHER a grant-letter URL OR this link.
--
-- SAFETY / IDEMPOTENCY:
--   * Purely additive. ADD COLUMN IF NOT EXISTS makes re-running a no-op.
--   * awaiting_settlement is NOT NULL DEFAULT false; on PostgreSQL 11+ a constant
--     default is a metadata-only change (no table rewrite; brief ACCESS EXCLUSIVE
--     to update the catalog). Existing rows read false.
--   * source_record_url is nullable with no default (metadata-only). Existing rows
--     get NULL.
--   * Nothing is backfilled or modified.
--
-- Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0103_bookable_gift_capture_columns.sql

ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS awaiting_settlement boolean NOT NULL DEFAULT false;

ALTER TABLE gifts_and_payments
  ADD COLUMN IF NOT EXISTS source_record_url text;
