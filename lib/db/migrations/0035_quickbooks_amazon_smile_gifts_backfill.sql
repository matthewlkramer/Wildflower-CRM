-- Migration 0035: Backfill — convert Amazon Smile payments into gifts
--
-- One-time catch-up. Mints a gifts_and_payments row for every Amazon Smile
-- staged payment still sitting in the QuickBooks review queue and links the
-- staged row to it (status = 'approved'). NOTHING is deleted.
--
-- Amazon Smile is Amazon's charitable-giving program: small, periodic
-- unrestricted donations remitted by Amazon. Every such row is a genuine gift,
-- coded to the 4000-series donation accounts (one historical row was miscoded
-- to "4030 Other Revenue" and got auto-excluded as `other_revenue` — it is
-- re-claimed here). All are attributed to the existing donor organization
-- "Amazon / Amazon Foundation" (id recbYyqxpJWo5bKRB).
--
-- This mirrors the app's own auto-mint path (quickbooksSync.ts MINT branch +
-- buildGiftValuesFromStaged in quickbooksGift.ts):
--   * Gift HEADER only — no gift_allocations. A fundraiser allocates afterward,
--     exactly as with an app-minted gift.
--   * Donor XOR — organization_id only (individual_giver_person_id /
--     household_id stay null), satisfying gifts_and_payments_donor_xor.
--   * staged row: status='approved', match_status='matched',
--     created_gift_id=<gift>, auto_applied=true. auto_applied=true keeps each
--     row REVERTIBLE from the UI (revert deletes the minted gift), so a single
--     mistaken conversion can be undone per-row.
--
-- Deliberate deviation from buildGiftValuesFromStaged: the gift name is set to
-- the literal 'Amazon Smile' rather than the payer/raw-reference fallback,
-- because a couple of these rows carry a blank payer and would otherwise be
-- named after their bank-memo line ("BUSINESS CHECKING (XXXXXX 8945)").
--
-- DOES NOT add an ongoing rule — future Amazon Smile payments still land in the
-- queue until the separate "auto-convert going forward" task ships.
--
-- IDEMPOTENCY / SAFETY:
--   * The gift id is deterministic ('qbas_' || staged_payment.id), so the
--     INSERT is ON CONFLICT (id) DO NOTHING and re-running mints nothing new.
--   * Only rows with NO existing gift link (created_gift_id IS NULL AND
--     matched_gift_id IS NULL) are touched, so already-converted rows are
--     skipped and re-running is a no-op.
--   * Intentionally does NOT reference group_reconciled_gift_id / qb_deposit_id:
--     those columns ship with the deposit-grouping schema (0034) which reaches
--     production only via Publish. Amazon Smile rows are individual small
--     payments, never part of a grouped bank deposit, so the
--     (created_gift_id IS NULL AND matched_gift_id IS NULL) filter is complete.
--
-- Verified against production at authoring time: exactly 14 target rows
-- (13 pending = $192.53, 1 excluded/other_revenue = $23.47).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0035_quickbooks_amazon_smile_gifts_backfill.sql

BEGIN;

-- Rows to convert: Amazon Smile payments still in the queue with no gift yet.
-- Matched by the program's markers anywhere on the row:
--   'amazon smile'  — the payer name ("Amazon Smile").
--   'amazonsmil'    — the remittance memo token ("… AmazonSmil 2303 …"), which
--                     covers rows whose payer is blank.
CREATE TEMPORARY TABLE _amazon_smile_targets ON COMMIT DROP AS
SELECT id, qb_entity_type, qb_entity_id, amount, date_received,
       matched_payment_intermediary_id
  FROM staged_payments
 WHERE (
         lower(concat_ws(' ', payer_name, raw_reference, line_description))
           LIKE '%amazon smile%'
      OR lower(concat_ws(' ', payer_name, raw_reference, line_description))
           LIKE '%amazonsmil%'
       )
   AND status IN ('pending', 'excluded')
   AND created_gift_id IS NULL
   AND matched_gift_id IS NULL;

-- Preflight guard: this is a reviewed one-time catch-up of a KNOWN scope (14
-- rows at authoring time). Abort if the matched set is anything other than the
-- expected 14 — or 0 for an idempotent re-run after success. Any other count
-- means the queue changed (new rows arrived, or the predicate over-matched);
-- re-review before converting. Bump EXPECTED only after re-verifying the set.
DO $$
DECLARE
  n int;
  expected int := 14;
BEGIN
  SELECT count(*) INTO n FROM _amazon_smile_targets;
  IF n NOT IN (0, expected) THEN
    RAISE EXCEPTION
      'Amazon Smile backfill aborted: expected 0 (re-run) or % target rows, found %. Re-review the target set before running.',
      expected, n;
  END IF;
  RAISE NOTICE 'Amazon Smile backfill: % target row(s) to convert.', n;
END $$;

-- 1) Mint the gift header for each target (Donor XOR = Amazon org only).
INSERT INTO gifts_and_payments
  (id, name, details, date_received, amount, organization_id,
   payment_intermediary_id, owner_user_id)
SELECT 'qbas_' || t.id,
       'Amazon Smile',
       'Imported from QuickBooks (' || t.qb_entity_type
         || ' #' || t.qb_entity_id || ').',
       t.date_received,
       t.amount,
       'recbYyqxpJWo5bKRB',            -- Amazon / Amazon Foundation
       t.matched_payment_intermediary_id,
       NULL                            -- auto-created: no acting user
  FROM _amazon_smile_targets t
ON CONFLICT (id) DO NOTHING;

-- 2) Link each staged row to its new gift and approve it. Stamp the donor on
--    the staged row too (XOR: org only) so the queue/Done view shows it, and
--    clear any stale exclusion_reason (the one re-claimed other_revenue row).
UPDATE staged_payments s
   SET status                     = 'approved',
       match_status               = 'matched',
       created_gift_id            = 'qbas_' || s.id,
       auto_applied               = true,
       organization_id            = 'recbYyqxpJWo5bKRB',
       individual_giver_person_id = NULL,
       household_id               = NULL,
       exclusion_reason           = NULL,
       updated_at                 = now()
  FROM _amazon_smile_targets t
 WHERE s.id = t.id;

-- Verification (expect 14 gifts named 'Amazon Smile' linked to approved rows):
--   SELECT count(*) FROM staged_payments
--    WHERE created_gift_id LIKE 'qbas_%' AND status = 'approved';
--   SELECT status, exclusion_reason, count(*)
--     FROM staged_payments GROUP BY 1,2 ORDER BY 1,2;

COMMIT;
