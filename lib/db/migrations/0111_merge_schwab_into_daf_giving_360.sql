-- Migration 0111: merge the duplicate "Schwab Charitable" payment intermediary
--                 into "DAF Giving 360".
--
-- WHY:
--   Schwab Charitable (a `daf`-type payment_intermediaries row) renamed itself to
--   "DAF Giving 360". Both names currently exist as SEPARATE payment_intermediaries
--   rows, so the same real-world DAF sponsor shows up twice in pickers and lists.
--   There is no in-app merge for payment intermediaries (the entity-merge engine
--   only covers organizations and people), so this is delivered the same way as
--   every other prod data change: a reviewed, idempotent SQL file + runbook,
--   applied by a human against production (invariant #7 — the agent cannot write
--   to prod).
--
--   Survivor — 'DAF Giving 360'    id recgLXRqc6jUJxxXm  (name already correct)
--   Loser    — 'Schwab Charitable' id recoHqSe1gJkIKVVb
--
--   Both are type = 'daf', neither archived, neither carries a
--   quickbooks_customer_id. Verified against production (read-only) at authoring
--   time, everything pointing at the loser is:
--     * gifts_and_payments.payment_intermediary_id            — 1 row
--     * staged_payments.matched_payment_intermediary_id       — 1 row
--     * every other reference column below                     — 0 rows
--   The survivor already owns 1 gift. Real footprint today: re-point 2 rows,
--   dedup nothing, then archive the loser.
--
-- WHAT THIS FILE DOES (DATA-only, idempotent, non-destructive):
--   1. Re-points EVERY column that can hold a reference to the loser over to the
--      survivor. Most are empty today but all are covered so the file is robust
--      and re-runnable. Two of them have NO FK constraint in production
--      (gifts_and_payments.payment_intermediary_id and
--      staged_payments.matched_payment_intermediary_id) — they are handled by the
--      same explicit UPDATE, so the lack of an FK makes no difference here.
--   2. Dedups the donor↔intermediary join (donor_payment_intermediaries) BEFORE
--      re-pointing: it has three partial unique indexes on
--      (donor, payment_intermediary_id) (org / person / household). Empty today,
--      but for safety any loser-owned link whose (donor, survivor) pair already
--      exists is deleted first, so re-pointing can never violate a unique index.
--   3. Preserves the survivor's identity defensively: sets name = 'DAF Giving 360'
--      (idempotent) and carries the loser's quickbooks_customer_id onto the
--      survivor ONLY if the survivor's is null and the loser's is not
--      (COALESCE(survivor, loser) — both null today).
--   4. Retires the loser via ARCHIVE, not hard delete: archived_at =
--      COALESCE(archived_at, now()) so it drops out of lists/pickers while staying
--      recoverable (invariant #6, archive-don't-delete). COALESCE keeps re-runs
--      from resetting the timestamp.
--
-- DERIVED STATE:
--   Re-pointing gifts_and_payments.payment_intermediary_id changes neither the
--   gift amount nor its QuickBooks links (matched/created/group_reconciled staged
--   rows, payment_applications, LinkedTxn), so the gift's derived-but-persisted
--   quickbooks_tie_status is UNAFFECTED. No re-derivation is needed.
--
-- IDEMPOTENCY / SAFETY:
--   * Every re-point UPDATE is scoped to `= '<loser>'`; after the first run no row
--     references the loser, so every subsequent run touches 0 rows.
--   * The dedup DELETE and the archive UPDATE are guarded (NOT DISTINCT FROM /
--     COALESCE), so re-running is a stable no-op.
--   * A preflight guard ABORTS if the survivor row is missing (wrong DB / wrong
--     id), so the file can never silently move data onto a non-existent row.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0111_merge_schwab_into_daf_giving_360.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.
-- The two ids are inlined as literals (NOT psql \set variables), because psql
-- does not substitute :vars inside the dollar-quoted DO blocks below.

-- ─── 0. Preflight guard: the survivor MUST exist ───────────────────────────
-- Abort loudly if we are pointed at the wrong database or the survivor id is
-- wrong — otherwise the re-point UPDATEs below would strand references on a
-- non-existent id. A missing loser is fine (already archived / never existed):
-- every re-point simply touches 0 rows.
DO $$
DECLARE
  n_survivor int;
  n_loser    int;
BEGIN
  SELECT count(*) INTO n_survivor
    FROM payment_intermediaries WHERE id = 'recgLXRqc6jUJxxXm';
  SELECT count(*) INTO n_loser
    FROM payment_intermediaries WHERE id = 'recoHqSe1gJkIKVVb';

  IF n_survivor <> 1 THEN
    RAISE EXCEPTION
      '0111 aborted: survivor recgLXRqc6jUJxxXm not found (found % row(s)). Wrong database or id?',
      n_survivor;
  END IF;

  RAISE NOTICE '0111: survivor present; loser recoHqSe1gJkIKVVb present = % row(s).',
    n_loser;
END $$;

-- ─── 1. Dedup the donor↔intermediary join BEFORE re-pointing ───────────────
-- Delete any loser-owned link whose (donor, survivor) pair already exists.
-- Donor XOR guarantees exactly one of the three donor FKs is non-null per row,
-- so IS NOT DISTINCT FROM (null-safe equality) correctly matches "same donor".
DELETE FROM donor_payment_intermediaries loser_link
WHERE loser_link.payment_intermediary_id = 'recoHqSe1gJkIKVVb'
  AND EXISTS (
    SELECT 1
      FROM donor_payment_intermediaries surv_link
     WHERE surv_link.payment_intermediary_id = 'recgLXRqc6jUJxxXm'
       AND surv_link.id <> loser_link.id
       AND surv_link.organization_id
             IS NOT DISTINCT FROM loser_link.organization_id
       AND surv_link.individual_giver_person_id
             IS NOT DISTINCT FROM loser_link.individual_giver_person_id
       AND surv_link.household_id
             IS NOT DISTINCT FROM loser_link.household_id
  );

-- ─── 2. Re-point every reference column loser -> survivor ───────────────────
-- No-FK columns (handled identically):
UPDATE gifts_and_payments
   SET payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE staged_payments
   SET matched_payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb';

-- FK-backed columns:
UPDATE staged_payments
   SET intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE donor_payment_intermediaries
   SET payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE organizations
   SET payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE people_entity_roles
   SET payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE emails
   SET payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE addresses
   SET payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE phone_numbers
   SET payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE donorbox_donations
   SET matched_payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb';

UPDATE stripe_staged_charges
   SET matched_payment_intermediary_id = 'recgLXRqc6jUJxxXm', updated_at = now()
 WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb';

-- ─── 3. Preserve the survivor's identity (idempotent) ──────────────────────
-- Force the desired name and carry the loser's quickbooks_customer_id ONLY if
-- the survivor lacks one and the loser has one (both null today).
UPDATE payment_intermediaries surv
   SET name = 'DAF Giving 360',
       quickbooks_customer_id = COALESCE(
         surv.quickbooks_customer_id,
         (SELECT lose.quickbooks_customer_id
            FROM payment_intermediaries lose WHERE lose.id = 'recoHqSe1gJkIKVVb')
       ),
       updated_at = now()
 WHERE surv.id = 'recgLXRqc6jUJxxXm';

-- ─── 4. Retire the loser via archive (soft-delete, recoverable) ────────────
UPDATE payment_intermediaries
   SET archived_at = COALESCE(archived_at, now()),
       updated_at = now()
 WHERE id = 'recoHqSe1gJkIKVVb';

-- ─── 5. Post-merge verification report (aborts on any leftover ref) ─────────
-- Every reference count on the loser must be 0; the survivor must own the moved
-- rows; the loser must be archived.
DO $$
DECLARE
  refs int;
  surv_gifts int;
  surv_staged int;
  loser_archived timestamptz;
BEGIN
  SELECT
      (SELECT count(*) FROM gifts_and_payments           WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM staged_payments              WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM staged_payments              WHERE intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM donor_payment_intermediaries WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM organizations                WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM people_entity_roles          WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM emails                       WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM addresses                    WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM phone_numbers                WHERE payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM donorbox_donations           WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    + (SELECT count(*) FROM stripe_staged_charges        WHERE matched_payment_intermediary_id = 'recoHqSe1gJkIKVVb')
    INTO refs;

  SELECT count(*) INTO surv_gifts
    FROM gifts_and_payments WHERE payment_intermediary_id = 'recgLXRqc6jUJxxXm';
  SELECT count(*) INTO surv_staged
    FROM staged_payments WHERE matched_payment_intermediary_id = 'recgLXRqc6jUJxxXm';
  SELECT archived_at INTO loser_archived
    FROM payment_intermediaries WHERE id = 'recoHqSe1gJkIKVVb';

  RAISE NOTICE '0111 result: remaining refs to loser = % (expect 0); survivor gifts = %, survivor matched staged = %; loser archived_at = %',
    refs, surv_gifts, surv_staged, loser_archived;

  IF refs <> 0 THEN
    RAISE EXCEPTION '0111 verification FAILED: % reference(s) to the loser remain', refs;
  END IF;
END $$;
