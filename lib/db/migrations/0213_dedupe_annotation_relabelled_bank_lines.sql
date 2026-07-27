-- 0213: collapse duplicate Wells Fargo bank lines minted by annotation churn.
--
-- The importer's dedup key included the export's annotation columns
-- (From/To, Donor, QB posting). When Wells/QBO relabelled the same physical
-- line between exports (e.g. "Frey Foundation" -> "Lirio (C)"), a re-import
-- minted a second bank_transactions row and a second bank_deposit — the
-- duplicate workbench rows. The importer now keys on stable bank facts only
-- (date|checkNo|description|spent|received); this migration repairs the
-- existing data to match:
--   1. groups bank_csv_export rows by the stable key;
--   2. keeps max-copies-in-any-one-file rows per key (genuine same-day
--      duplicates live in one file with distinct occurrences), preferring
--      rows whose deposit carries evidence;
--   3. repoints components / exclusions / source_links / payout ties from
--      surplus deposits to the kept one, then deletes the surplus
--      deposits + transactions;
--   4. rewrites every bank_csv_export dedup_key to the stable form and
--      renumbers occurrence, so future imports are idempotent again.
--
-- Prod-only data repair; idempotent. Apply AFTER merging the importer fix:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0213_dedupe_annotation_relabelled_bank_lines.sql
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

CREATE TEMP TABLE _0213_rows ON COMMIT DROP AS
SELECT
  bt.id,
  bt.dedup_key AS old_key,
  bt.occurrence AS old_occurrence,
  bt.source_file,
  to_char(bt.txn_date, 'MM/DD/YYYY')
    || '|' || COALESCE(bt.ref_no, '')
    || '|' || COALESCE(bt.memo, '')
    || '|' || COALESCE(bt.payment::text, '')
    || '|' || COALESCE(bt.deposit::text, '') AS stable_key,
  d.id AS dep_id,
  (SELECT count(*) FROM bank_deposit_components c WHERE c.bank_deposit_id = d.id)
    + (SELECT count(*) FROM bank_deposit_exclusions e WHERE e.bank_deposit_id = d.id)
    + (SELECT count(*) FROM source_links sl WHERE sl.bank_deposit_id = d.id)
    + (SELECT count(*) FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
    + (SELECT count(*) FROM source_links sl WHERE sl.bank_transaction_id = bt.id) AS evidence
FROM bank_transactions bt
LEFT JOIN bank_deposits d ON d.source_bank_transaction_id = bt.id
WHERE bt.source = 'bank_csv_export';

CREATE TEMP TABLE _0213_ranked ON COMMIT DROP AS
SELECT r.*,
  row_number() OVER (
    PARTITION BY r.stable_key
    ORDER BY r.evidence DESC, r.old_key, r.old_occurrence, r.id
  ) AS rn,
  (SELECT max(cnt) FROM (
     SELECT count(*) AS cnt FROM _0213_rows x
     WHERE x.stable_key = r.stable_key GROUP BY x.source_file
   ) per_file) AS genuine
FROM _0213_rows r;

CREATE TEMP TABLE _0213_victims ON COMMIT DROP AS
SELECT v.id, v.dep_id, k.id AS keeper_id, k.dep_id AS keeper_dep_id
FROM _0213_ranked v
JOIN _0213_ranked k ON k.stable_key = v.stable_key AND k.rn = 1
WHERE v.rn > v.genuine;

-- Repoint deposit-plane evidence from surplus deposits to the kept deposit.
UPDATE bank_deposit_components c
SET bank_deposit_id = v.keeper_dep_id
FROM _0213_victims v
WHERE c.bank_deposit_id = v.dep_id AND v.keeper_dep_id IS NOT NULL;

UPDATE bank_deposit_exclusions e
SET bank_deposit_id = v.keeper_dep_id
FROM _0213_victims v
WHERE e.bank_deposit_id = v.dep_id
  AND v.keeper_dep_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM bank_deposit_exclusions k
    WHERE k.bank_deposit_id = v.keeper_dep_id
  );
DELETE FROM bank_deposit_exclusions e
USING _0213_victims v
WHERE e.bank_deposit_id = v.dep_id;

UPDATE source_links sl
SET bank_deposit_id = v.keeper_dep_id
FROM _0213_victims v
WHERE sl.bank_deposit_id = v.dep_id AND v.keeper_dep_id IS NOT NULL;

UPDATE source_links sl
SET bank_transaction_id = v.keeper_id
FROM _0213_victims v
WHERE sl.bank_transaction_id = v.id;

UPDATE stripe_payouts p
SET bank_deposit_id = v.keeper_dep_id
FROM _0213_victims v
WHERE p.bank_deposit_id = v.dep_id AND v.keeper_dep_id IS NOT NULL;

DELETE FROM bank_deposits d
USING _0213_victims v
WHERE d.id = v.dep_id;

DELETE FROM bank_transactions bt
USING _0213_victims v
WHERE bt.id = v.id;

-- Rewrite the surviving rows onto the stable key (two-phase to dodge the
-- unique index during renumbering).
CREATE TEMP TABLE _0213_rekey ON COMMIT DROP AS
SELECT r.id, r.stable_key,
  row_number() OVER (
    PARTITION BY r.stable_key
    ORDER BY r.old_key, r.old_occurrence, r.id
  ) - 1 AS new_occurrence
FROM _0213_ranked r
WHERE NOT EXISTS (SELECT 1 FROM _0213_victims v WHERE v.id = r.id);

UPDATE bank_transactions bt
SET dedup_key = '0213_tmp|' || bt.id
FROM _0213_rekey k
WHERE bt.id = k.id
  AND (bt.dedup_key <> k.stable_key OR bt.occurrence <> k.new_occurrence);

UPDATE bank_transactions bt
SET dedup_key = k.stable_key, occurrence = k.new_occurrence
FROM _0213_rekey k
WHERE bt.id = k.id AND bt.dedup_key LIKE '0213_tmp|%';

-- Postconditions: no surplus rows remain, and no tmp keys were left behind.
DO $$
DECLARE tmp int;
BEGIN
  SELECT count(*) INTO tmp FROM bank_transactions
  WHERE dedup_key LIKE '0213\_tmp|%';
  IF tmp > 0 THEN
    RAISE EXCEPTION '0213: % rows left with temporary dedup keys', tmp;
  END IF;
END $$;

DO $$
DECLARE remaining int;
BEGIN
  WITH per_file AS (
    SELECT txn_date, ref_no, memo, payment, deposit, source_file, count(*) AS cnt
    FROM bank_transactions
    WHERE source = 'bank_csv_export'
    GROUP BY 1, 2, 3, 4, 5, 6
  )
  SELECT count(*) INTO remaining FROM (
    SELECT txn_date, ref_no, memo, payment, deposit
    FROM per_file
    GROUP BY 1, 2, 3, 4, 5
    HAVING sum(cnt) > max(cnt)
  ) surplus_groups;
  IF remaining > 0 THEN
    RAISE EXCEPTION '0213: % stable-key groups still carry surplus rows', remaining;
  END IF;
END $$;
