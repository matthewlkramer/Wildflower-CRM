-- Migration 0047: Remove worker-minted QuickBooks gifts (keep Amazon Smile)
--
-- CONTEXT
--   The QuickBooks sync worker's "auto-apply" step used to MINT a brand-new
--   gifts_and_payments row whenever a high-confidence donor match had NO existing
--   gift to reconcile to (quickbooksSync.ts autoApply, the giftCandidateCount = 0
--   branch). A full re-pull ran that branch across the entire QuickBooks back
--   catalogue and auto-created 153 gifts with NO human review — $10,273,112.72
--   total, including large foundation grants (Spring Point $1M, Walton, Valhalla
--   $500k, Gates, Sep Kamvar, ...). Many duplicate gifts already in the CRM (the
--   Copper / Airtable imported originals).
--
--   Intended behaviour (per the product owner):
--     * Amazon Smile micro-deposits SHOULD auto-create gifts without review —
--       they are real QBO gifts never logged in the CRM, and are now handled by
--       the `seed_amazonsmile` handling rule (auto_create_approve -> GenOps).
--     * EVERY OTHER would-be auto-create must instead land in the needs-review
--       queue for a human to approve.
--
--   The accompanying code change (quickbooksSync.ts) removes the worker's generic
--   mint branch, so going forward the worker only RECONCILES to a single existing
--   gift and otherwise leaves the row pending. This migration cleans up what that
--   branch already minted: it DELETES the 139 non-Amazon worker mints and returns
--   every attached QuickBooks staged payment to the needs-review queue. The 14
--   Amazon Smile mints are KEPT.
--
-- WORKER-MINT MARKER (set by buildGiftValuesFromStaged, the sole minter):
--     details LIKE 'Imported from QuickBooks (%'  -- QB-minted (reconcile never
--                                                    rewrites an existing gift's
--                                                    details, so this is mint-only)
--     AND owner_user_id IS NULL                   -- worker mint (a human approve
--                                                    stamps the acting user)
--     AND legacy_gift_id IS NULL                  -- not a Copper import
--     AND created_at_from_airtable IS NULL        -- not an Airtable import
--   KEEP filter: name !~* 'amazon\s*smil'         -- exclude Amazon Smile, the one
--                                                    auto-create the owner wants
--
-- REQUEUE: every staged_payments row whose matched_gift_id / created_gift_id /
--   group_reconciled_gift_id points at a removed gift is reset to 'pending',
--   mirroring the app's per-row revert (revertOneStagedPayment): gift links and
--   approval / confirmation stamps cleared, auto_applied = false. The donor hint
--   (organization / individual / household) is RETAINED so the reviewer keeps the
--   system's guess. Orphaned mints (a prior re-ingest already wiped their staged
--   link) have no row to reset; their QBO record, when re-pulled, is already a
--   fresh pending row in the queue.
--
-- FK SAFETY (verified against production at authoring time):
--   * gift_allocations.gift_id (RESTRICT) — cleared first; exactly 1 remove-set
--     gift (Valhalla Foundation $500k) carries an allocation.
--   * staged_payment_splits.gift_id (RESTRICT) — 0 remove-set references (splits
--     only ever reconcile to PRE-EXISTING gifts); guarded below.
--   * staged_payments matched / created / group gift FKs (SET NULL) — reset
--     explicitly to 'pending' before the delete (so no row is left 'approved'
--     with a null gift).
--   * gifts_and_payments.gift_being_matched_id self-ref (SET NULL) — automatic.
--
-- IDEMPOTENCY / SAFETY:
--   * Scope is provenance-based, not a hard-coded id list; re-running after
--     success finds 0 remove-set gifts, so every statement is a no-op.
--   * The preflight guard aborts unless the remove set is exactly 139 (authoring
--     scope) or 0 (idempotent re-run). Any other count means production drifted
--     (e.g. the worker minted again before the code fix shipped) — re-review and
--     bump EXPECTED before running.
--   * Nothing outside the 139 worker mints + their staged links is touched.
--   * PUBLISH the api-server code change too, or the next sync re-mints these.
--
-- APPLY (dev is done by the agent; production by a human — the agent cannot write
-- to prod):
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0047_quickbooks_remove_worker_minted_gifts.sql

BEGIN;

-- 1) The worker-minted gifts to REMOVE (all worker mints EXCEPT Amazon Smile).
CREATE TEMPORARY TABLE _qb_worker_mints_remove ON COMMIT DROP AS
SELECT id, name, amount
  FROM gifts_and_payments
 WHERE details LIKE 'Imported from QuickBooks (%'
   AND owner_user_id IS NULL
   AND legacy_gift_id IS NULL
   AND created_at_from_airtable IS NULL
   AND name !~* 'amazon\s*smil';

-- 2) Preflight guard — known reviewed scope (139 at authoring time, 0 on re-run).
DO $$
DECLARE
  n int;
  expected int := 139;
BEGIN
  SELECT count(*) INTO n FROM _qb_worker_mints_remove;
  IF n NOT IN (0, expected) THEN
    RAISE EXCEPTION
      'Remove-worker-mints aborted: expected 0 (re-run) or % gifts, found %. Re-review the set before running.',
      expected, n;
  END IF;
  RAISE NOTICE 'Worker-mint cleanup: % gift(s) to remove.', n;
END $$;

-- 2b) Safety guard — no split reconciles to a remove-set gift (a split only ever
--     links a PRE-EXISTING gift, so this should be 0; RESTRICT would otherwise
--     block the delete and signal an unexpected linkage).
DO $$
DECLARE
  s int;
BEGIN
  SELECT count(*) INTO s
    FROM staged_payment_splits
   WHERE gift_id IN (SELECT id FROM _qb_worker_mints_remove);
  IF s > 0 THEN
    RAISE EXCEPTION
      'Remove-worker-mints aborted: % staged_payment_splits reference the remove set (unexpected).', s;
  END IF;
END $$;

-- 3) Requeue every staged row attached to a removed gift back to needs-review
--    (mirrors revertOneStagedPayment; donor hint retained).
DO $$
DECLARE
  r int;
BEGIN
  UPDATE staged_payments s
     SET status                     = 'pending',
         matched_gift_id            = NULL,
         created_gift_id            = NULL,
         group_reconciled_gift_id   = NULL,
         auto_applied               = false,
         match_confirmed_by_user_id = NULL,
         match_confirmed_at         = NULL,
         approved_by_user_id        = NULL,
         approved_at                = NULL,
         updated_at                 = now()
   WHERE s.matched_gift_id          IN (SELECT id FROM _qb_worker_mints_remove)
      OR s.created_gift_id          IN (SELECT id FROM _qb_worker_mints_remove)
      OR s.group_reconciled_gift_id IN (SELECT id FROM _qb_worker_mints_remove);
  GET DIAGNOSTICS r = ROW_COUNT;
  RAISE NOTICE 'Requeued % staged payment(s) to needs-review (expected ~89).', r;
END $$;

-- 4) Clear gift_allocations on the remove set (RESTRICT FK; the Valhalla $500k
--    rule-created row has one) so the gift delete can proceed.
DO $$
DECLARE
  a int;
BEGIN
  DELETE FROM gift_allocations
   WHERE gift_id IN (SELECT id FROM _qb_worker_mints_remove);
  GET DIAGNOSTICS a = ROW_COUNT;
  RAISE NOTICE 'Cleared % gift_allocation(s) on the remove set (expected 1).', a;
END $$;

-- 5) Delete the worker-minted gifts.
DO $$
DECLARE
  d int;
BEGIN
  DELETE FROM gifts_and_payments
   WHERE id IN (SELECT id FROM _qb_worker_mints_remove);
  GET DIAGNOSTICS d = ROW_COUNT;
  RAISE NOTICE 'Deleted % worker-minted gift(s) (expected 139).', d;
END $$;

-- Verification (after COMMIT):
--   -- Worker mints remaining should be ONLY the 14 kept Amazon Smile gifts:
--   SELECT count(*) AS worker_mints_remaining,
--          count(*) FILTER (WHERE name ~* 'amazon\s*smil') AS amazon_kept
--     FROM gifts_and_payments
--    WHERE details LIKE 'Imported from QuickBooks (%'
--      AND owner_user_id IS NULL AND legacy_gift_id IS NULL
--      AND created_at_from_airtable IS NULL;          -- expect 14 / 14
--   -- No staged row left 'approved' pointing at a now-deleted gift:
--   SELECT count(*) FROM staged_payments
--    WHERE status = 'approved'
--      AND matched_gift_id IS NULL AND created_gift_id IS NULL
--      AND group_reconciled_gift_id IS NULL;          -- (informational)

COMMIT;
