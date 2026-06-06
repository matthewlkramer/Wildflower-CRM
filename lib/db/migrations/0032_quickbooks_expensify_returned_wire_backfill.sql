-- Migration 0032: Backfill — expensify + returned-wire exclusions
--
-- Re-runs the new `expensify` and `returned_wire` rules over the EXISTING
-- QuickBooks review queue. Matching rows are marked status = 'excluded'.
-- NOTHING is deleted.
--
-- This mirrors classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--   * Both are IDENTITY / TEXT rules — NO donation-first guard. They identify
--     money that is categorically not a gift regardless of how the line is coded.
--   * expensify     — case-insensitive SUBSTRING 'expensify' anywhere on the row
--                     (payer, memo, line_description, Class, item, account).
--   * returned_wire — the phrase "returned wire" anywhere on the row,
--                     whitespace-tolerant (POSIX `returned[[:space:]]+wire`,
--                     i.e. the classifier's /returned\s+wire/i).
--
-- RULE PRECEDENCE (first-match-wins, mirrored here by statement ORDER):
--   * In the classifier both fire BEFORE the donation guard, right after
--     `insurance` (… fiscally_sponsored → insurance → expensify → returned_wire →
--     [donation guard] → …). They precede every guarded line-based rule, so a row
--     matching either marker is excluded with the new reason regardless of any
--     other coding. The pending-only filter here preserves that: a row already
--     excluded under another reason is left untouched (status <> 'pending').
--   * `expensify` runs before `returned_wire` to match the classifier order,
--     though in practice the two markers never co-occur.
--
-- ⚠️ KEEP THIS IN LOCKSTEP WITH THE CLASSIFIER: the markers live in
-- EXPENSIFY_MARKER_SUBSTRINGS and RETURNED_WIRE_TEXT_PATTERNS in
-- quickbooksExclusionRules.ts. If you change them there, change them here (or
-- just re-run the in-app reclassify).
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are NOT modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--   * Any expensify / returned-wire rows that were previously auto-excluded under
--     a different reason (before these reasons existed) are already out of the
--     queue, so this pending-only backfill leaves their old label in place.
--     Reclassify by hand only if the precise label matters (see runbook).
--
-- PREREQUISITES:
--   1. 0031_quickbooks_expensify_returned_wire_enum.sql has COMMITTED (the new
--      enum values must exist before this transaction can use them).
--   2. The new app code is deployed AND existing rows carry line detail
--      (line_description / line_account_names / line_item_names / line_classes).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0032_quickbooks_expensify_returned_wire_backfill.sql

BEGIN;

-- ─── Expensify expense-reimbursement activity ("expensify") → expensify ─────
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'expensify',
       updated_at = now()
 WHERE status = 'pending'
   AND lower(concat_ws(' ',
         payer_name,
         raw_reference,
         line_description,
         array_to_string(coalesce(line_classes,       '{}'::text[]), ' '),
         array_to_string(coalesce(line_item_names,    '{}'::text[]), ' '),
         array_to_string(coalesce(line_account_names, '{}'::text[]), ' ')
       )) LIKE '%expensify%';

-- ─── Returned wire transfers ("returned wire") → returned_wire ──────────────
-- Whitespace-tolerant: `returned[[:space:]]+wire` mirrors the classifier's
-- /returned\s+wire/i (matches "returned wire" / "returned  wire" / "RETURNED
-- WIRE") but not stray single tokens.
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'returned_wire',
       updated_at = now()
 WHERE status = 'pending'
   AND lower(concat_ws(' ',
         payer_name,
         raw_reference,
         line_description,
         array_to_string(coalesce(line_classes,       '{}'::text[]), ' '),
         array_to_string(coalesce(line_item_names,    '{}'::text[]), ' '),
         array_to_string(coalesce(line_account_names, '{}'::text[]), ' ')
       )) ~ 'returned[[:space:]]+wire';

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
