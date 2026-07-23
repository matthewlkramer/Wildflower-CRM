-- 0157 — Recode the 10 one-unit→N-gifts clusters (ADR linear-money-model §6/§7 step 4).
--
-- After this migration EVERY evidence unit carries at most ONE counted
-- payment_applications row (the precondition for the step-5 counted-uniqueness
-- partial unique index, which ships as a SEPARATE later file).
--
-- Apply (human-run, from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0157_recode_counted_duplicate_units.sql
--
-- Idempotent: a second run performs zero writes (every statement is guarded).
-- No BEGIN/COMMIT here — psql -1 wraps the whole file in one transaction, and
-- the postflight DO block RAISEs (rolling everything back) if any invariant
-- fails.
--
-- Mechanisms used (canonical only):
--   * merge   — survivor gift absorbs the cluster: allocations moved (UPDATE
--               gift_allocations SET gift_id), losers archived (archived_at,
--               never hard-deleted), loser counted PAs DELETEd (the ledger
--               revert mechanism), survivor PA amount_applied = unit amount.
--   * split   — deterministic synthetic children (`<parentId>:split:<n>`,
--               mirroring stagedPaymentSplitUnits.ts field-for-field) for the
--               two units that genuinely bundle several money events.
--   * pledge_expected_payments backfill for the three fixed-commitment
--               pledges whose historical installment schedule was implicit.
--   * final re-derivation of paid/status/stage/written_pledge/win_probability
--               for every affected opportunity, mirroring the CURRENT
--               deriveOppFields (pledgeStage.ts) — NOT the stale 0070 SQL.
--
-- Ratified deviations from the ADR §6 table (recorded in the ADR in the same
-- change; see 0157_RUNBOOK.md for the reasoning):
--   * Omidyar 2019 wire (4Jn9…) is SPLIT into 2×$500k units instead of merged:
--     its two gifts sit on two different pledges and `paid` is a gift-header
--     rollup — a single-gift merge would corrupt one pledge's paid.
--   * Nash keeps 6 allocation rows and Kamvar keeps 4 (the "3 allocations" in
--     §6 are the money buckets; collapsing would destroy school/region grain).
--   * LISC Q1 FY24: gift corrected UP 50¢ to the money actually received
--     ($7,712.50); the GV direct-to-school allocation absorbs the 50¢.
--   * Frey (user ruling 2026-07-23): the FY24 renewal was in fact paid by its
--     OWN $30,000 check (2024-05-30) that sat matched-but-unaccounted in the
--     workbench. The FY24 gift therefore becomes a STANDALONE gift (detached
--     from the pledge, NOT archived) whose counted row re-points to that
--     check. The pledge becomes FY25–FY26, $60,000, paid in full by the
--     single 2025-04-08 wire: one gift with fy2025 + fy2026 ($30k each)
--     allocations, the FY26 one Wildflower-restricted.

-- ═════════════════════════════════════════════════════════════════════════
-- PREFLIGHT — invariants that must hold BEFORE and AFTER (safe on re-run)
-- ═════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  n int;
BEGIN
  -- The 11 anchor evidence units exist with the expected amounts
  -- (10 cluster anchors + Frey's standalone FY24 check).
  SELECT count(*) INTO n FROM staged_payments
   WHERE (id, amount) IN (
     ('4svk9IxogJIjkx65k097w', 1000000.00),
     ('4Jn9XEMRrTWvBKKRiMU4f', 1000000.00),
     ('57hcboHFPuX4qdljSM449', 10000.00),
     ('AkvrooAk4pfsKl1lKWKvz', 25000.00),
     ('WWbM-Xk_oxrSHO4zm6NT6', 3500.00),
     ('a0BRZPHlxfgrW1Z0_sRis', 8578.61),
     ('i9nY0GFAjF76PpdSAqbxS', 7712.50),
     ('bllTXRZplXrsjM2VD7ws9', 200000.00),
     ('jpy0gpkGm_1U-_RKbLcux', 478660.14),
     ('y8JJig930lOjP9c9HN3uR', 60000.00),
     ('2fDjAxyTfYL0h1Jx8xyd1', 30000.00));
  IF n <> 11 THEN
    RAISE EXCEPTION '0157 preflight: expected 11 anchor units with the recorded amounts, found %', n;
  END IF;

  -- The two split parents carry no settlement/source-link claims (the runtime
  -- split guard we are deliberately bypassing also checks these).
  SELECT count(*) INTO n FROM settlement_links
   WHERE deposit_staged_payment_id IN ('4Jn9XEMRrTWvBKKRiMU4f','57hcboHFPuX4qdljSM449');
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 preflight: split parent carries settlement_links (%)', n;
  END IF;
  SELECT count(*) INTO n FROM source_links
   WHERE qb_staged_payment_id IN ('4Jn9XEMRrTWvBKKRiMU4f','57hcboHFPuX4qdljSM449');
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 preflight: split parent carries source_links (%)', n;
  END IF;

  -- Frey's second installment books to grant_year 'fy2026' (B8) — fail fast
  -- with a clear message if the FK target is missing.
  SELECT count(*) INTO n FROM fiscal_years WHERE id = 'fy2026';
  IF n <> 1 THEN
    RAISE EXCEPTION '0157 preflight: fiscal_years is missing the fy2026 row';
  END IF;

  -- Frey: the 2024-05-30 $30k check must carry no payment application other
  -- than the FY24 gift's re-pointed counted row (B8 writes exactly that one;
  -- the guard tolerates a re-run). Anything else means prod has drifted from
  -- the analyzed snapshot.
  SELECT count(*) INTO n FROM payment_applications
   WHERE payment_id = '2fDjAxyTfYL0h1Jx8xyd1'
     AND id <> 'd8bc0ac1-3d5d-4504-b1ac-bbe3861bbba6';
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 preflight: % unexpected payment_applications on the Frey 2024-05-30 check', n;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- A. SPLIT UNITS — Omidyar 2019 wire (4Jn9…) and Kao two-checks deposit (57hc…)
--    Children mirror stagedPaymentSplitUnits.ts exactly: deterministic ids,
--    qb_entity_id stays NULL, classification/entity sources pinned 'manual'.
-- ═════════════════════════════════════════════════════════════════════════

INSERT INTO staged_payments (
  id, split_parent_id, realm_id, qb_entity_type, qb_deposit_id,
  amount, date_received, payer_name, line_description,
  qb_deposit_to_account_name, classification_source, entity_id, entity_source
)
SELECT p.id || ':split:' || v.n, p.id, p.realm_id, p.qb_entity_type, p.qb_deposit_id,
       v.amt, p.date_received, p.payer_name, p.line_description,
       p.qb_deposit_to_account_name, 'manual', p.entity_id, 'manual'
  FROM staged_payments p
 CROSS JOIN (VALUES (1, 500000.00::numeric), (2, 500000.00::numeric)) AS v(n, amt)
 WHERE p.id = '4Jn9XEMRrTWvBKKRiMU4f'
ON CONFLICT (id) DO NOTHING;

INSERT INTO staged_payments (
  id, split_parent_id, realm_id, qb_entity_type, qb_deposit_id,
  amount, date_received, payer_name, line_description,
  qb_deposit_to_account_name, classification_source, entity_id, entity_source
)
SELECT p.id || ':split:' || v.n, p.id, p.realm_id, p.qb_entity_type, p.qb_deposit_id,
       v.amt, p.date_received, p.payer_name, p.line_description,
       p.qb_deposit_to_account_name, 'manual', p.entity_id, 'manual'
  FROM staged_payments p
 CROSS JOIN (VALUES (1, 5000.00::numeric), (2, 5000.00::numeric)) AS v(n, amt)
 WHERE p.id = '57hcboHFPuX4qdljSM449'
ON CONFLICT (id) DO NOTHING;

-- Re-anchor each counted row onto its child unit (parent then derives the
-- terminal 'split' presentation; nothing else references the parents).
-- Omidyar: split:1 = FY20 gift (pledge Fy18-20), split:2 = FY21 gift (pledge FY21-23).
UPDATE payment_applications
   SET payment_id = '4Jn9XEMRrTWvBKKRiMU4f:split:1', updated_at = now()
 WHERE id = 'cfde97df-e177-4d34-a36c-a0aab14abb4b'
   AND payment_id = '4Jn9XEMRrTWvBKKRiMU4f';

UPDATE payment_applications
   SET payment_id = '4Jn9XEMRrTWvBKKRiMU4f:split:2', updated_at = now()
 WHERE id = '8a5b3cbf-885f-4aeb-bf18-f319445b5404'
   AND payment_id = '4Jn9XEMRrTWvBKKRiMU4f';

-- Kao: split:1 = check #1 gift, split:2 = check #2 gift.
UPDATE payment_applications
   SET payment_id = '57hcboHFPuX4qdljSM449:split:1', updated_at = now()
 WHERE id = '1a3cfe6d-9da0-43d3-bd6e-be0620accbf0'
   AND payment_id = '57hcboHFPuX4qdljSM449';

UPDATE payment_applications
   SET payment_id = '57hcboHFPuX4qdljSM449:split:2', updated_at = now()
 WHERE id = '6cf8e49e-165c-4119-a780-5d774f7863c6'
   AND payment_id = '57hcboHFPuX4qdljSM449';

-- ═════════════════════════════════════════════════════════════════════════
-- B. MERGES — one survivor gift per single-money-event unit
-- ═════════════════════════════════════════════════════════════════════════

-- ── B1. Omidyar 2017 wire (4svk…, $1,000,000, 2017-12-01) ──────────────────
-- Survivor recAjHdhK9R6eEAi1 (FY18) absorbs recgLkgoCHL05n7mZ (FY19).
UPDATE gift_allocations
   SET gift_id = 'recAjHdhK9R6eEAi1', updated_at = now()
 WHERE id = 'synth-ga-recgLkgoCHL05n7mZ'
   AND gift_id = 'recgLkgoCHL05n7mZ';

UPDATE gifts_and_payments
   SET amount = 1000000.00,
       date_received = DATE '2017-12-01',
       name = 'Omidyar Grant FY18–FY19',
       updated_at = now()
 WHERE id = 'recAjHdhK9R6eEAi1'
   AND (amount IS DISTINCT FROM 1000000.00
     OR date_received IS DISTINCT FROM DATE '2017-12-01'
     OR name IS DISTINCT FROM 'Omidyar Grant FY18–FY19');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || 'Single $1,000,000 Omidyar wire received 2017-12-01, covering the FY18 and FY19 installments; formerly recorded as two $500,000 gifts. [0157]',
       updated_at = now()
 WHERE id = 'recAjHdhK9R6eEAi1'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

UPDATE gifts_and_payments
   SET archived_at = now(), updated_at = now()
 WHERE id = 'recgLkgoCHL05n7mZ' AND archived_at IS NULL;

DELETE FROM payment_applications WHERE id = '9ca421e1-631a-41f8-85ac-3e45fda6c98c';

UPDATE payment_applications
   SET amount_applied = 1000000.00, updated_at = now()
 WHERE id = 'fa987394-cbaf-46c7-a829-68616733c907'
   AND amount_applied IS DISTINCT FROM 1000000.00;

-- ── B2. McKnight (Akvr…, $25,000, 2023-07-27) ──────────────────────────────
-- One check, formerly two identical $12,500 gifts. Survivor recReHXt8wdJxqRwL.
UPDATE gift_allocations
   SET sub_amount = 25000.00, updated_at = now()
 WHERE id = 'synth-ga-recReHXt8wdJxqRwL'
   AND sub_amount IS DISTINCT FROM 25000.00;

UPDATE gifts_and_payments
   SET amount = 25000.00,
       date_received = DATE '2023-07-27',
       updated_at = now()
 WHERE id = 'recReHXt8wdJxqRwL'
   AND (amount IS DISTINCT FROM 25000.00
     OR date_received IS DISTINCT FROM DATE '2023-07-27');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || 'Single $25,000 McKnight check received 2023-07-27; formerly recorded as two $12,500 gifts. [0157]',
       updated_at = now()
 WHERE id = 'recReHXt8wdJxqRwL'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

UPDATE gifts_and_payments
   SET archived_at = now(), updated_at = now()
 WHERE id = 'recrmfdpKoADPXlWx' AND archived_at IS NULL;

DELETE FROM payment_applications WHERE id = 'ada6f0ce-22e7-464f-9711-8e6bb04f996a';

UPDATE payment_applications
   SET amount_applied = 25000.00, updated_at = now()
 WHERE id = 'a5be490a-eaea-4fe6-b741-80bc3309cdf4'
   AND amount_applied IS DISTINCT FROM 25000.00;

-- ── B3. AOL Giving Foundation (WWbM…, $3,500, 2025-01-31) ──────────────────
-- Gates matching grant + Tosha Downey employee match arrived as ONE check via
-- the AOL Giving Foundation DAF. Survivor = Gates gift; the intermediary
-- carries the conduit; the employee detail lives in the memo (ADR §6).
UPDATE gift_allocations
   SET sub_amount = 3500.00, updated_at = now()
 WHERE id = 'synth-ga-recYeA9b5NLTUTWUE'
   AND sub_amount IS DISTINCT FROM 3500.00;

UPDATE gifts_and_payments
   SET amount = 3500.00,
       date_received = DATE '2025-01-31',
       payment_intermediary_id = 'reclFJefmPi7hZrod',
       name = 'FY25 $3,500 Gates matching grant (incl. Tosha Downey employee match)',
       updated_at = now()
 WHERE id = 'recYeA9b5NLTUTWUE'
   AND (amount IS DISTINCT FROM 3500.00
     OR date_received IS DISTINCT FROM DATE '2025-01-31'
     OR payment_intermediary_id IS DISTINCT FROM 'reclFJefmPi7hZrod'
     OR name IS DISTINCT FROM 'FY25 $3,500 Gates matching grant (incl. Tosha Downey employee match)');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || '$875 of this gift is the Tosha Downey employee match, formerly recorded as its own gift; the whole $3,500 arrived as one American Online Giving Foundation check. [0157]',
       updated_at = now()
 WHERE id = 'recYeA9b5NLTUTWUE'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

UPDATE gifts_and_payments
   SET archived_at = now(), updated_at = now()
 WHERE id = 'recGpltnPNwQQXuQ3' AND archived_at IS NULL;

DELETE FROM payment_applications WHERE id = 'w8GNcrxtphBmqCIQMnPxP';

UPDATE payment_applications
   SET amount_applied = 3500.00, updated_at = now()
 WHERE id = '7EJ9Fr93-d2xoBSDgJPPO'
   AND amount_applied IS DISTINCT FROM 3500.00;

-- ── B4. LISC Q2 FY24 (a0BR…, $8,578.61, 2023-12-14) ────────────────────────
-- Survivor = LISC CO reimbursement gift; the GV direct-to-school allocation
-- moves onto it (its former gift is archived).
UPDATE gift_allocations
   SET gift_id = 'recaRy7Df5cVDP39A', updated_at = now()
 WHERE id = 'synth-ga-rec3oRv55Z6Roz2XO'
   AND gift_id = 'rec3oRv55Z6Roz2XO';

UPDATE gifts_and_payments
   SET amount = 8578.61,
       name = 'Q2 FY24 LISC Reimbursement (CO + GV direct-to-school)',
       updated_at = now()
 WHERE id = 'recaRy7Df5cVDP39A'
   AND (amount IS DISTINCT FROM 8578.61
     OR name IS DISTINCT FROM 'Q2 FY24 LISC Reimbursement (CO + GV direct-to-school)');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || 'Single $8,578.61 LISC payment; formerly recorded as separate CO ($4,631.25) and GV direct-to-school ($3,947.36) gifts. [0157]',
       updated_at = now()
 WHERE id = 'recaRy7Df5cVDP39A'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

UPDATE gifts_and_payments
   SET archived_at = now(), updated_at = now()
 WHERE id = 'rec3oRv55Z6Roz2XO' AND archived_at IS NULL;

DELETE FROM payment_applications WHERE id = '45b37153-23f7-4c10-8f44-470d2844901a';

UPDATE payment_applications
   SET amount_applied = 8578.61, updated_at = now()
 WHERE id = '22e7d2f7-b881-453c-84f6-01db751e0da8'
   AND amount_applied IS DISTINCT FROM 8578.61;

-- ── B5. LISC Q1 FY24 (i9nY…, $7,712.50, 2023-11-06) ────────────────────────
-- Same shape as B4, plus the 50¢ correction: the money received is $7,712.50
-- but the two gifts summed to $7,712.00. The gift is corrected UP to the money
-- (the codebase rule: the gift and the money stay in agreement); the GV
-- allocation absorbs the 50¢.
UPDATE gift_allocations
   SET gift_id = 'recgULJNTegkP2JVW', sub_amount = 2875.50, updated_at = now()
 WHERE id = 'synth-ga-recqQHz5vP7iOaLZd'
   AND gift_id = 'recqQHz5vP7iOaLZd';

UPDATE gifts_and_payments
   SET amount = 7712.50,
       date_received = DATE '2023-11-06',
       name = 'Q1 FY24 LISC Reimbursement (CO + GV direct-to-school)',
       updated_at = now()
 WHERE id = 'recgULJNTegkP2JVW'
   AND (amount IS DISTINCT FROM 7712.50
     OR date_received IS DISTINCT FROM DATE '2023-11-06'
     OR name IS DISTINCT FROM 'Q1 FY24 LISC Reimbursement (CO + GV direct-to-school)');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || 'Single $7,712.50 LISC payment; formerly recorded as separate CO ($4,837.00) and GV direct-to-school ($2,875.00) gifts, which under-recorded the money by $0.50 — the GV allocation absorbs the 50 cents. [0157]',
       updated_at = now()
 WHERE id = 'recgULJNTegkP2JVW'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

UPDATE gifts_and_payments
   SET archived_at = now(), updated_at = now()
 WHERE id = 'recqQHz5vP7iOaLZd' AND archived_at IS NULL;

DELETE FROM payment_applications WHERE id = 'b890ab0f-d6b5-4661-b202-a3562e000736';

UPDATE payment_applications
   SET amount_applied = 7712.50, updated_at = now()
 WHERE id = '56d9697c-c7ca-4d76-bc63-22eb0cd8266a'
   AND amount_applied IS DISTINCT FROM 7712.50;

-- ── B6. Nash (bllT…, $200,000 wire from "Avi and Sandra Nash", 2020-12-31) ──
-- One personal wire, formerly three gifts with XOR-conflicting donors (two
-- under the Indira Foundation org). Survivor = the household gift (the actual
-- payer). All school-designation allocation grain is preserved (6 rows).
UPDATE gift_allocations
   SET gift_id = 'rec5a0mpX29ZUeJrU', updated_at = now()
 WHERE gift_id IN ('rec2twqm58PjFRhhf', 'rec6B0yqPIR47JbIa');

UPDATE gifts_and_payments
   SET amount = 200000.00,
       date_received = DATE '2020-12-31',
       name = 'Avi and Sandra Nash — FY21 $200,000 wire',
       updated_at = now()
 WHERE id = 'rec5a0mpX29ZUeJrU'
   AND (amount IS DISTINCT FROM 200000.00
     OR date_received IS DISTINCT FROM DATE '2020-12-31'
     OR name IS DISTINCT FROM 'Avi and Sandra Nash — FY21 $200,000 wire');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || 'Single $200,000 wire from Avi and Sandra Nash (Goldman) received 2020-12-31; formerly recorded as three gifts, two attributed to the Indira Foundation. Includes the $7,000 Emerging Hub Grant to Goldenrod and the school designations (Sundrops, Flame Lily, Lotus). [0157]',
       updated_at = now()
 WHERE id = 'rec5a0mpX29ZUeJrU'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

UPDATE gifts_and_payments
   SET archived_at = now(), updated_at = now()
 WHERE id IN ('rec2twqm58PjFRhhf', 'rec6B0yqPIR47JbIa') AND archived_at IS NULL;

DELETE FROM payment_applications
 WHERE id IN ('1b58b3fb-5cc4-4c8d-aaa6-b3acdbb08888', '34c1abfa-c7f3-47bb-8994-d0dd4f87ec02');

UPDATE payment_applications
   SET amount_applied = 200000.00, updated_at = now()
 WHERE id = 'a8756208-a2f8-4ae2-bea4-d74bf0d0102e'
   AND amount_applied IS DISTINCT FROM 200000.00;

-- ── B7. Kamvar (jpy0…, $478,660.14, 2020-12-29) ────────────────────────────
-- One wire, formerly three gifts. Survivor = the ledger-created gift (62FZ…).
-- Rising Tide consolidates into the survivor's existing RT allocation
-- ($126,436.14 + $200,000 = $326,436.14); the partnership-passthrough
-- (counts_toward_goal=false), the AZ gen-ops, and the Northern-NJ gen-ops
-- allocations MOVE intact (region grain preserved → 4 allocation rows).
UPDATE gift_allocations
   SET sub_amount = 326436.14, updated_at = now()
 WHERE id = 'e8saxUtqR9XbOZUaVHLMd'
   AND sub_amount IS DISTINCT FROM 326436.14;

UPDATE gift_allocations
   SET gift_id = '62FZlSLpjELvIk-cFaBDE', updated_at = now()
 WHERE id IN ('recjkLLE8wVhS4tfy', 'reczFkKTYwdDZ9FRG', 'synth-ga-recGLjt4K2Tvwullp')
   AND gift_id IN ('reczOdxsO03GKyiVs', 'recGLjt4K2Tvwullp');
-- (the loser's own $200,000 RT allocation stays on the archived gift — its
--  money now lives in the survivor's consolidated RT allocation)

UPDATE gifts_and_payments
   SET amount = 478660.14, updated_at = now()
 WHERE id = '62FZlSLpjELvIk-cFaBDE'
   AND amount IS DISTINCT FROM 478660.14;

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || 'Single $478,660.14 Sep Kamvar wire received 2020-12-29; formerly recorded as three gifts (Rising Tide $126,436.14, $337,224 multi-purpose, and $15,000 Northern NJ gen-ops). Rising Tide is consolidated at $326,436.14; the $15,000 partnership passthrough does not count toward goal. [0157]',
       updated_at = now()
 WHERE id = '62FZlSLpjELvIk-cFaBDE'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

UPDATE gifts_and_payments
   SET archived_at = now(), updated_at = now()
 WHERE id IN ('reczOdxsO03GKyiVs', 'recGLjt4K2Tvwullp') AND archived_at IS NULL;

DELETE FROM payment_applications
 WHERE id IN ('eOWEWGJKjQK6N-XjaGDTF', 'qLjcMe9zlk90TCY3BPiW7');

UPDATE payment_applications
   SET amount_applied = 478660.14, updated_at = now()
 WHERE id = 'JwsxZhXUp7uOPcuZ40ZDw'
   AND amount_applied IS DISTINCT FROM 478660.14;

-- ── B8. Frey — TWO real money events (user ruling 2026-07-23) ──────────────
-- Not a merge. The QB evidence shows two Frey Foundation payments:
--   * $30,000 check, 2024-05-30 (2fDj…) — the FY24 renewal, paid on its own.
--     It sat 'matched' in the workbench but carried NO counted row, while the
--     FY24 gift was wrongly counted against the 2025 wire.
--   * $60,000 wire, 2025-04-08 (y8JJ…, via the Minneapolis Foundation) —
--     pays the FY25–FY26 pledge in full.
-- Recoding: the FY24 gift (recJtIJR0PemacXLE) becomes a STANDALONE gift —
-- detached from the pledge, dated to its actual check, counted against 2fDj…
-- (this also cures the matched-but-unaccounted drift on that unit). The FY25
-- gift (rechXgpevejd0ZO8c) becomes the pledge's single $60,000 payment with
-- two $30k allocations: fy2025 and fy2026 (Wildflower-restricted, per the
-- user's next-fiscal-year rule). The pledge is retitled FY25–FY26 and its
-- plan allocations retag to fy2025 + fy2026.

-- FY24 gift: standalone, on its real money date; keeps its fy2024 allocation.
UPDATE gifts_and_payments
   SET opportunity_id = NULL,
       date_received = DATE '2024-05-30',
       updated_at = now()
 WHERE id = 'recJtIJR0PemacXLE'
   AND (opportunity_id IS NOT NULL
     OR date_received IS DISTINCT FROM DATE '2024-05-30');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || '$30,000 Frey Foundation check received 2024-05-30 — the FY24 renewal, paid separately; formerly recorded as an installment on the FY25–FY26 pledge and mis-counted against the 2025 $60,000 wire. [0157]',
       updated_at = now()
 WHERE id = 'recJtIJR0PemacXLE'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

-- Re-point its counted row from the wire onto the 2024 check (not deleted —
-- the application is correct, it was anchored to the wrong evidence unit).
UPDATE payment_applications
   SET payment_id = '2fDjAxyTfYL0h1Jx8xyd1', updated_at = now()
 WHERE id = 'd8bc0ac1-3d5d-4504-b1ac-bbe3861bbba6'
   AND payment_id = 'y8JJig930lOjP9c9HN3uR';

-- FY25 gift becomes the pledge's single $60,000 payment…
UPDATE gifts_and_payments
   SET amount = 60000.00,
       date_received = DATE '2025-04-08',
       name = 'Frey Renewal FY25–FY26',
       updated_at = now()
 WHERE id = 'rechXgpevejd0ZO8c'
   AND (amount IS DISTINCT FROM 60000.00
     OR date_received IS DISTINCT FROM DATE '2025-04-08'
     OR name IS DISTINCT FROM 'Frey Renewal FY25–FY26');

UPDATE gifts_and_payments
   SET memo_description = COALESCE(NULLIF(memo_description, '') || E'\n', '')
         || 'Single $60,000 Frey Foundation wire received 2025-04-08 (via the Minneapolis Foundation), paying the FY25–FY26 pledge in full: $30,000 for FY25 and $30,000 for FY26 (Wildflower-restricted). The FY24 renewal was paid separately by a 2024-05-30 check. [0157]',
       updated_at = now()
 WHERE id = 'rechXgpevejd0ZO8c'
   AND (memo_description IS NULL OR position('[0157]' in memo_description) = 0);

-- …with a NEW fy2026 allocation mirroring its fy2025 sibling (same region /
-- usage / entity grain), Wildflower-restricted.
INSERT INTO gift_allocations (
  id, gift_id, sub_amount, grant_year, intended_usage, region_ids, entity_id,
  regional_restriction_type, other_restriction_type, time_restriction_type,
  counts_toward_goal
)
SELECT '0157-ga-rechXgpevejd0ZO8c-fy2026', ga.gift_id, 30000.00, 'fy2026',
       ga.intended_usage, ga.region_ids, ga.entity_id,
       ga.regional_restriction_type, 'wf_restricted', ga.time_restriction_type,
       ga.counts_toward_goal
  FROM gift_allocations ga
 WHERE ga.id = 'synth-ga-rechXgpevejd0ZO8c'
ON CONFLICT (id) DO NOTHING;

UPDATE payment_applications
   SET amount_applied = 60000.00, updated_at = now()
 WHERE id = 'bae7f11d-27b8-40dc-a683-947fd203c88a'
   AND amount_applied IS DISTINCT FROM 60000.00;

-- Pledge header + plan allocations now say what the pledge IS: $60,000 for
-- FY25 + FY26 (the fy2024 plan row retags to fy2026; amounts unchanged).
UPDATE opportunities_and_pledges
   SET name = 'Frey FY25-26', updated_at = now()
 WHERE id = 'receJJXlRMjmar0y6'
   AND name IS DISTINCT FROM 'Frey FY25-26';

UPDATE pledge_allocations
   SET grant_year = 'fy2026', updated_at = now()
 WHERE id = 'recJEP1GUMzzPt1xv'
   AND grant_year = 'fy2024';

-- ═════════════════════════════════════════════════════════════════════════
-- C. PLEDGE EXPECTED-PAYMENTS BACKFILL (historical schedule; fiscal-year
--    anchored planned dates — actuals live on the gifts/QB, never here)
-- ═════════════════════════════════════════════════════════════════════════

INSERT INTO pledge_expected_payments (id, pledge_or_opportunity_id, expected_date, amount, notes)
VALUES
  ('0157-pep-recL1luStEQ05Ca9r-fy2018', 'recL1luStEQ05Ca9r', DATE '2017-07-01', 500000.00, 'historical schedule backfill (0157)'),
  ('0157-pep-recL1luStEQ05Ca9r-fy2019', 'recL1luStEQ05Ca9r', DATE '2018-07-01', 500000.00, 'historical schedule backfill (0157)'),
  ('0157-pep-recL1luStEQ05Ca9r-fy2020', 'recL1luStEQ05Ca9r', DATE '2019-07-01', 500000.00, 'historical schedule backfill (0157)'),
  ('0157-pep-recmvAyYs3BB65oET-fy2021', 'recmvAyYs3BB65oET', DATE '2020-07-01', 500000.00, 'historical schedule backfill (0157)'),
  ('0157-pep-recmvAyYs3BB65oET-fy2022', 'recmvAyYs3BB65oET', DATE '2021-07-01', 500000.00, 'historical schedule backfill (0157)'),
  ('0157-pep-recmvAyYs3BB65oET-fy2023', 'recmvAyYs3BB65oET', DATE '2022-07-01', 500000.00, 'historical schedule backfill (0157)'),
  ('0157-pep-receJJXlRMjmar0y6-1',      'receJJXlRMjmar0y6', DATE '2024-07-01', 30000.00,  'historical schedule backfill (0157) — FY25 installment'),
  ('0157-pep-receJJXlRMjmar0y6-2',      'receJJXlRMjmar0y6', DATE '2025-07-01', 30000.00,  'historical schedule backfill (0157) — FY26 installment (both paid upfront by the 2025-04-08 wire)')
ON CONFLICT (id) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- D. RE-DERIVE affected opportunities/pledges.
--    Mirrors the CURRENT deriveOppFields (pledgeStage.ts), NOT the stale 0070
--    SQL: written_pledge latches ONLY on an unpaid grant letter; status
--    precedence loss_type > cash_in (model-aware fully-paid) > pledge > open;
--    a won row reads stage='complete'; stale 'complete' reverts to
--    'verbal_confirmation'; win_probability from status/conditional/stage.
-- ═════════════════════════════════════════════════════════════════════════

WITH affected AS (
  SELECT DISTINCT g.opportunity_id AS id
    FROM gifts_and_payments g
   WHERE g.opportunity_id IS NOT NULL
     AND g.id IN (
       'recAjHdhK9R6eEAi1','recgLkgoCHL05n7mZ','reckelLlxExPB5C6e','recRfzkuB6wB6QlRr',
       'recfNNQt6xxEfcQNz','rec5MgcANAINnbNL1','recReHXt8wdJxqRwL','recrmfdpKoADPXlWx',
       'recYeA9b5NLTUTWUE','recGpltnPNwQQXuQ3','recaRy7Df5cVDP39A','rec3oRv55Z6Roz2XO',
       'recgULJNTegkP2JVW','recqQHz5vP7iOaLZd','rec2twqm58PjFRhhf','rec6B0yqPIR47JbIa',
       'rec5a0mpX29ZUeJrU','62FZlSLpjELvIk-cFaBDE','reczOdxsO03GKyiVs','recGLjt4K2Tvwullp',
       'rechXgpevejd0ZO8c','recJtIJR0PemacXLE')
),
paid_calc AS (
  SELECT a.id,
         COALESCE((SELECT SUM(g.amount) FROM gifts_and_payments g
                    WHERE g.opportunity_id = a.id AND g.archived_at IS NULL), 0)::numeric(14,2) AS new_paid
    FROM affected a
),
cond AS (
  SELECT a.id,
         CASE
           WHEN COUNT(pa.id) = 0 THEN NULL
           WHEN COUNT(*) FILTER (WHERE pa.conditional::text IN
                ('conditional_unspecified','conditional_on_funder_determination','conditional_on_target')) = 0
             THEN 'unconditional'
           ELSE MIN(pa.conditional::text) FILTER (WHERE pa.conditional::text IN
                ('conditional_unspecified','conditional_on_funder_determination','conditional_on_target'))
         END AS rolled_conditional
    FROM affected a
    LEFT JOIN pledge_allocations pa ON pa.pledge_or_opportunity_id = a.id
   GROUP BY a.id
),
calc AS (
  SELECT o.id, p.new_paid,
         CASE WHEN o.disbursement_model::text = 'cost_reimbursement'
              THEN o.award_closed_at IS NOT NULL
              ELSE COALESCE(o.awarded_amount, 0) > 0 AND p.new_paid >= o.awarded_amount
         END AS fully_paid,
         o.loss_type::text AS loss_type,
         COALESCE(o.written_pledge, false) AS cur_wp,
         o.grant_letter_url,
         o.stage::text AS cur_stage,
         c.rolled_conditional
    FROM affected a
    JOIN opportunities_and_pledges o ON o.id = a.id
    JOIN paid_calc p ON p.id = a.id
    JOIN cond c ON c.id = a.id
),
derived AS (
  SELECT id, new_paid, cur_stage, rolled_conditional,
         (cur_wp OR (grant_letter_url IS NOT NULL AND NOT fully_paid)) AS new_wp,
         CASE
           WHEN loss_type IN ('dormant','lost') THEN loss_type
           WHEN fully_paid THEN 'cash_in'
           WHEN cur_wp OR (grant_letter_url IS NOT NULL AND NOT fully_paid) THEN 'pledge'
           ELSE 'open'
         END AS new_status
    FROM calc
),
final AS (
  SELECT id, new_paid, new_wp, new_status,
         CASE WHEN new_status IN ('pledge','cash_in') THEN 'complete'
              WHEN cur_stage = 'complete' THEN 'verbal_confirmation'
              ELSE cur_stage END AS new_stage,
         (CASE
            WHEN new_status IN ('lost','dormant') THEN 0.0000
            WHEN new_status = 'cash_in' THEN 1.0000
            WHEN new_status = 'pledge' THEN
              CASE WHEN rolled_conditional IN
                     ('conditional_unspecified','conditional_on_funder_determination','conditional_on_target')
                   THEN 0.7500 ELSE 0.9000 END
            ELSE CASE COALESCE(CASE WHEN cur_stage = 'complete' THEN 'verbal_confirmation' ELSE cur_stage END, '')
                   WHEN 'cold_lead' THEN 0.0000
                   WHEN 'warm_lead' THEN 0.0500
                   WHEN 'in_conversation' THEN 0.2000
                   WHEN 'convince' THEN 0.4000
                   WHEN 'probable_renewal' THEN 0.7500
                   WHEN 'verbal_confirmation' THEN 0.9000
                   WHEN 'conditional_commitment' THEN 0.7500
                   WHEN 'written_commitment' THEN 0.9000
                   WHEN 'cash_in' THEN 1.0000
                   WHEN 'complete' THEN 1.0000
                   ELSE 0.0000 END
          END)::numeric(5,4) AS new_win_probability
    FROM derived
)
UPDATE opportunities_and_pledges o
   SET paid            = f.new_paid,
       written_pledge  = f.new_wp,
       status          = f.new_status::opportunity_status,
       stage           = f.new_stage::opportunity_stage,
       win_probability = f.new_win_probability,
       updated_at      = now()
  FROM final f
 WHERE o.id = f.id
   AND (o.paid            IS DISTINCT FROM f.new_paid
     OR o.written_pledge  IS DISTINCT FROM f.new_wp
     OR o.status::text    IS DISTINCT FROM f.new_status
     OR o.stage::text     IS DISTINCT FROM f.new_stage
     OR o.win_probability IS DISTINCT FROM f.new_win_probability);

-- ═════════════════════════════════════════════════════════════════════════
-- E. POSTFLIGHT — hard invariants; any failure RAISEs and rolls back the
--    whole file (psql -1 single transaction).
-- ═════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  n int;
BEGIN
  -- E1. NO evidence unit anywhere carries more than one counted row.
  SELECT count(*) INTO n FROM (
    SELECT payment_id FROM payment_applications
     WHERE payment_id IS NOT NULL AND link_role = 'counted'
     GROUP BY payment_id HAVING count(*) > 1) d;
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 postflight: % evidence units still carry multiple counted rows', n;
  END IF;

  -- E2. The split parents carry no payment applications at all.
  SELECT count(*) INTO n FROM payment_applications
   WHERE payment_id IN ('4Jn9XEMRrTWvBKKRiMU4f','57hcboHFPuX4qdljSM449');
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 postflight: split parents still carry % payment applications', n;
  END IF;

  -- E3. Each split parent has exactly 2 children summing to the parent.
  SELECT count(*) INTO n
    FROM staged_payments p
   WHERE p.id IN ('4Jn9XEMRrTWvBKKRiMU4f','57hcboHFPuX4qdljSM449')
     AND (SELECT count(*) FROM staged_payments c WHERE c.split_parent_id = p.id) = 2
     AND (SELECT SUM(c.amount) FROM staged_payments c WHERE c.split_parent_id = p.id) = p.amount;
  IF n <> 2 THEN
    RAISE EXCEPTION '0157 postflight: split children malformed (parents passing: %)', n;
  END IF;

  -- E4. Every live unit in scope has counted rows summing EXACTLY to its amount.
  SELECT count(*) INTO n FROM (
    SELECT sp.id
      FROM staged_payments sp
      LEFT JOIN payment_applications pa
        ON pa.payment_id = sp.id AND pa.link_role = 'counted'
     WHERE sp.id IN (
       '4svk9IxogJIjkx65k097w','AkvrooAk4pfsKl1lKWKvz','WWbM-Xk_oxrSHO4zm6NT6',
       'a0BRZPHlxfgrW1Z0_sRis','i9nY0GFAjF76PpdSAqbxS','bllTXRZplXrsjM2VD7ws9',
       'jpy0gpkGm_1U-_RKbLcux','y8JJig930lOjP9c9HN3uR','2fDjAxyTfYL0h1Jx8xyd1',
       '4Jn9XEMRrTWvBKKRiMU4f:split:1','4Jn9XEMRrTWvBKKRiMU4f:split:2',
       '57hcboHFPuX4qdljSM449:split:1','57hcboHFPuX4qdljSM449:split:2')
     GROUP BY sp.id, sp.amount
    HAVING COALESCE(SUM(pa.amount_applied), 0) IS DISTINCT FROM sp.amount) x;
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 postflight: % units whose counted sum <> unit amount', n;
  END IF;

  -- E5. Every NON-ARCHIVED touched gift: allocations sum exactly to the amount.
  SELECT count(*) INTO n FROM (
    SELECT g.id
      FROM gifts_and_payments g
      LEFT JOIN gift_allocations ga ON ga.gift_id = g.id
     WHERE g.archived_at IS NULL
       AND g.id IN (
         'recAjHdhK9R6eEAi1','reckelLlxExPB5C6e','recRfzkuB6wB6QlRr',
         'recfNNQt6xxEfcQNz','rec5MgcANAINnbNL1','recReHXt8wdJxqRwL',
         'recYeA9b5NLTUTWUE','recaRy7Df5cVDP39A','recgULJNTegkP2JVW',
         'rec5a0mpX29ZUeJrU','62FZlSLpjELvIk-cFaBDE','rechXgpevejd0ZO8c',
         'recJtIJR0PemacXLE')
     GROUP BY g.id, g.amount
    HAVING COALESCE(SUM(ga.sub_amount), 0) IS DISTINCT FROM g.amount) x;
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 postflight: % surviving gifts whose allocation sum <> amount', n;
  END IF;

  -- E6. The 9 loser gifts are archived; the survivors are not.
  SELECT count(*) INTO n FROM gifts_and_payments
   WHERE archived_at IS NULL
     AND id IN ('recgLkgoCHL05n7mZ','recrmfdpKoADPXlWx','recGpltnPNwQQXuQ3',
                'rec3oRv55Z6Roz2XO','recqQHz5vP7iOaLZd','rec2twqm58PjFRhhf',
                'rec6B0yqPIR47JbIa','reczOdxsO03GKyiVs','recGLjt4K2Tvwullp');
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 postflight: % loser gifts not archived', n;
  END IF;

  -- E6b. The Frey FY24 gift is LIVE, standalone, on its real money date, and
  --      counted against the 2024-05-30 check.
  SELECT count(*) INTO n FROM gifts_and_payments g
   WHERE g.id = 'recJtIJR0PemacXLE'
     AND g.archived_at IS NULL
     AND g.opportunity_id IS NULL
     AND g.amount = 30000.00
     AND g.date_received = DATE '2024-05-30'
     AND EXISTS (SELECT 1 FROM payment_applications pa
                  WHERE pa.id = 'd8bc0ac1-3d5d-4504-b1ac-bbe3861bbba6'
                    AND pa.gift_id = g.id
                    AND pa.payment_id = '2fDjAxyTfYL0h1Jx8xyd1'
                    AND pa.link_role = 'counted'
                    AND pa.amount_applied = 30000.00);
  IF n <> 1 THEN
    RAISE EXCEPTION '0157 postflight: Frey FY24 standalone gift state is wrong';
  END IF;

  -- E6c. The Frey pledge plan reads FY25 + FY26 (one $30k row each).
  SELECT count(*) INTO n FROM pledge_allocations
   WHERE pledge_or_opportunity_id = 'receJJXlRMjmar0y6'
     AND grant_year IN ('fy2025','fy2026')
     AND sub_amount = 30000.00;
  IF n <> 2 THEN
    RAISE EXCEPTION '0157 postflight: Frey pledge allocations not FY25+FY26 (found %)', n;
  END IF;

  -- E7. paid parity on EVERY opportunity reachable from a touched gift
  --     (the same set Section D re-derives), stored == live rollup.
  SELECT count(*) INTO n
    FROM opportunities_and_pledges o
    LEFT JOIN (SELECT opportunity_id, COALESCE(SUM(amount),0)::numeric(14,2) AS s
                 FROM gifts_and_payments
                WHERE archived_at IS NULL AND opportunity_id IS NOT NULL
                GROUP BY opportunity_id) g ON g.opportunity_id = o.id
   WHERE o.id IN (SELECT DISTINCT opportunity_id FROM gifts_and_payments
                   WHERE opportunity_id IS NOT NULL AND id IN (
                     'recAjHdhK9R6eEAi1','recgLkgoCHL05n7mZ','reckelLlxExPB5C6e','recRfzkuB6wB6QlRr',
                     'recfNNQt6xxEfcQNz','rec5MgcANAINnbNL1','recReHXt8wdJxqRwL','recrmfdpKoADPXlWx',
                     'recYeA9b5NLTUTWUE','recGpltnPNwQQXuQ3','recaRy7Df5cVDP39A','rec3oRv55Z6Roz2XO',
                     'recgULJNTegkP2JVW','recqQHz5vP7iOaLZd','rec2twqm58PjFRhhf','rec6B0yqPIR47JbIa',
                     'rec5a0mpX29ZUeJrU','62FZlSLpjELvIk-cFaBDE','reczOdxsO03GKyiVs','recGLjt4K2Tvwullp',
                     'rechXgpevejd0ZO8c','recJtIJR0PemacXLE'))
     AND o.paid IS DISTINCT FROM COALESCE(g.s, 0);
  IF n <> 0 THEN
    RAISE EXCEPTION '0157 postflight: % opportunities with paid drift', n;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- Manual verification (run after apply; second full run of this file must
-- report zero rows written everywhere):
--
--   -- Global counted-duplicate count (expect 0):
--   SELECT count(*) FROM (
--     SELECT payment_id FROM payment_applications
--      WHERE payment_id IS NOT NULL AND link_role = 'counted'
--      GROUP BY payment_id HAVING count(*) > 1) d;
--
--   -- The 4 recoded pledges (expect cash_in / complete; recXg24nW0jTUOyE4
--   --  gains the 50¢: 50,799.50; the Frey pledge receJJXlRMjmar0y6 stays
--   --  paid 60,000 — now one $60k gift instead of two $30k gifts, with the
--   --  FY24 $30k moved off-pledge as a standalone gift):
--   SELECT id, status::text, stage::text, awarded_amount, paid
--     FROM opportunities_and_pledges
--    WHERE id IN ('recL1luStEQ05Ca9r','recmvAyYs3BB65oET',
--                 'recXg24nW0jTUOyE4','receJJXlRMjmar0y6');
--
--   -- Expected-payment backfill (expect 8 rows):
--   SELECT count(*) FROM pledge_expected_payments WHERE id LIKE '0157-pep-%';
-- ═════════════════════════════════════════════════════════════════════════
