-- 0129 — Retro-apply charge-tie supersede: move gift↔charge tied QB counted
--        rows to the charge grain, demote the QB source rows, re-derive
--        quickbooks_tie_status.
--
-- Context (prod audit, 2026-07-16): before applyChargeTieSupersedePairs
-- existed, confirming a gift↔charge tie (stripe_staged_charges.
-- linked_qb_staged_payment_id) did NOT move the tied QB row's counted
-- booking to the charge grain. Result: 95 counted QB rows sit behind
-- confirmed ties whose money IS the tied Stripe charge — so the
-- /reconciliation-clusters view shows already-booked money as unlinked at
-- the charge grain. This file applies exactly the decision the app's
-- supersede module (chargeTieSupersede.ts, decideChargeTieSupersede) now
-- makes on every new tie confirm/revert:
--
--   counted QB row (amount NOT NULL) + tied charge + EXACT same-money test
--   (staged_payments.amount equals charge gross OR net to the cent — no
--   fee band; override-mismatch ties are untouched):
--     - charge has NO counted Stripe row for the gift → MOVE: book a
--       counted Stripe copy on the charge (copies amount + provenance,
--       note starts with the app's marker `charge_tie_supersede:<qbId>`),
--       then demote the QB row to `corroborating` KEEPING the amount
--       (supersede-managed; the app's revert path promotes it back).
--     - charge already counted for the SAME gift → DEMOTE ONLY (the money
--       trail already lives at the charge grain).
--     - booking the copy would over-apply the charge's gross cap
--       → conservative SKIP (booking stays visible on the QB row);
--       see the RUNBOOK's human-review list (2 rows).
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0129_charge_tie_supersede_backfill.sql
--
-- Safety / idempotency:
--   - Every statement is guarded on current facts (tie present, link_role =
--     'counted', exact-cents same-money, gross cap). Re-run: the inserted
--     copies make the NOT EXISTS guard false and the demoted rows are no
--     longer 'counted', so every statement is a no-op (all zeros).
--   - The predicates are byte-for-byte the app's rule
--     (decideChargeTieSupersede + qbRowAmountMatchesCharge exact-cents test
--     + checkBookOnce gross-cap guard), so the app's next supersede pass
--     agrees with every row this file touches.
--   - Corrections-flow rows (amount_applied IS NULL) are never touched
--     (supersede discriminator).
--   - The moved copies use deterministic ids ('pacts_' || source row id), so
--     a hypothetical double-run that slipped the guards would fail loudly on
--     the PK instead of double-booking.
--   - Prod audit found ZERO QB staged payments with more than one tied
--     charge, so the tie join cannot fan out.
--   - No BEGIN/COMMIT here — psql -1 wraps the file in one transaction.

-- 1) MOVE, part 1 (expected: 86 rows, $38,581.42): book a counted Stripe
--    copy on the tied charge for every movable QB counted row. Copies the
--    human-ratified amount + provenance (allocation, match method,
--    confirmer); note starts with the app's marker so the app's revert path
--    recognizes and removes it.
INSERT INTO payment_applications
  (id, payment_id, gift_id, gift_allocation_id, amount_applied,
   evidence_source, stripe_charge_id, match_method, link_role, lifecycle,
   confirmed_by_user_id, confirmed_at, note, created_the_gift,
   created_at, updated_at)
SELECT
  'pacts_' || pa.id, NULL, pa.gift_id, pa.gift_allocation_id,
  pa.amount_applied, 'stripe', cc.id, pa.match_method, 'counted',
  'confirmed', pa.confirmed_by_user_id, pa.confirmed_at,
  'charge_tie_supersede:' || pa.payment_id
    || ' | repair 0129: moved from the tied QB row by retroactive charge-tie supersede',
  false, now(), now()
FROM payment_applications pa
JOIN stripe_staged_charges cc ON cc.linked_qb_staged_payment_id = pa.payment_id
JOIN staged_payments sp ON sp.id = pa.payment_id
WHERE pa.evidence_source = 'quickbooks'
  AND pa.link_role = 'counted'
  AND pa.amount_applied IS NOT NULL
  -- exact-cents same-money test (qbRowAmountMatchesCharge): QB row amount
  -- equals the charge gross OR net to the cent — no band.
  AND (round(sp.amount * 100) = round(cc.gross_amount * 100)
    OR round(sp.amount * 100) = round(cc.net_amount * 100))
  -- charge not already counted for this gift (else demote-only, step 3)
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications spa
    WHERE spa.stripe_charge_id = cc.id
      AND spa.evidence_source = 'stripe'
      AND spa.link_role = 'counted'
      AND spa.gift_id = pa.gift_id)
  -- gross-cap guard (checkBookOnce): counted sum for OTHER gifts + the copy
  -- must fit under the charge gross — else conservative skip.
  AND (
    SELECT coalesce(sum(spa.amount_applied), 0)
    FROM payment_applications spa
    WHERE spa.stripe_charge_id = cc.id
      AND spa.link_role = 'counted'
      AND spa.gift_id <> pa.gift_id
  ) + pa.amount_applied <= cc.gross_amount + 0.01;

-- 2) Clear any pre-existing corroborating row that would collide with a
--    demotion on the partial UNIQUE (payment_id, gift_id) WHERE
--    corroborating — mirrors the app's demote path. (Prod audit found zero
--    colliding rows, so this expects 0; kept for exact-mirror safety.)
DELETE FROM payment_applications victim
WHERE victim.link_role = 'corroborating'
  AND victim.evidence_source = 'quickbooks'
  AND EXISTS (
    SELECT 1
    FROM payment_applications pa
    JOIN stripe_staged_charges cc ON cc.linked_qb_staged_payment_id = pa.payment_id
    JOIN staged_payments sp ON sp.id = pa.payment_id
    WHERE pa.payment_id = victim.payment_id
      AND pa.gift_id = victim.gift_id
      AND pa.id <> victim.id
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND pa.amount_applied IS NOT NULL
      AND (round(sp.amount * 100) = round(cc.gross_amount * 100)
        OR round(sp.amount * 100) = round(cc.net_amount * 100))
      AND EXISTS (
        SELECT 1 FROM payment_applications spa
        WHERE spa.stripe_charge_id = cc.id
          AND spa.evidence_source = 'stripe'
          AND spa.link_role = 'counted'
          AND spa.gift_id = pa.gift_id)
  );

-- 3) THE DEMOTE (expected: 93 rows, $40,086.44 — the 86 moved rows + 7
--    demote-only rows whose charge was already counted for the same gift).
--    Counted QB rows behind a confirmed exact-money tie whose charge now
--    carries a counted Stripe row for the same gift. Amount is KEPT
--    (supersede-managed corroborating row; the app's revert path promotes
--    it back when the tie is removed).
UPDATE payment_applications pa
SET link_role  = 'corroborating',
    note       = coalesce(pa.note || ' | ', '')
                 || 'repair 0129: demoted to corroborating — money re-expressed at the charge grain by the tied Stripe charge (retroactive charge-tie supersede)',
    updated_at = now()
FROM stripe_staged_charges cc, staged_payments sp
WHERE cc.linked_qb_staged_payment_id = pa.payment_id
  AND sp.id = pa.payment_id
  AND pa.evidence_source = 'quickbooks'
  AND pa.link_role = 'counted'
  AND pa.amount_applied IS NOT NULL
  AND (round(sp.amount * 100) = round(cc.gross_amount * 100)
    OR round(sp.amount * 100) = round(cc.net_amount * 100))
  AND EXISTS (
    SELECT 1 FROM payment_applications spa
    WHERE spa.stripe_charge_id = cc.id
      AND spa.evidence_source = 'stripe'
      AND spa.link_role = 'counted'
      AND spa.gift_id = pa.gift_id);

-- 4) Re-derive quickbooks_tie_status (mirrors applyGiftQbTieMany /
--    deriveGiftQbTie) for every gift now holding a supersede-managed
--    corroborating QB row (amount NOT NULL) — a superset that also
--    re-checks the 0125-demoted gifts (IS DISTINCT FROM makes those
--    no-ops). Per-source PRECEDENCE (QB counted sum wins, else Stripe, else
--    Donorbox — never a cross-source SUM); off-books gifts are exempt;
--    band = amountWithinFeeBand(evidence = link sum, gift = gift amount).
UPDATE gifts_and_payments g
SET quickbooks_tie_status = c.computed::gift_quickbooks_tie,
    updated_at            = now()
FROM (
  SELECT g2.id,
    CASE
      WHEN EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g2.id)
        AND NOT EXISTS (
          SELECT 1 FROM gift_allocations ga
          LEFT JOIN entities e ON e.id = ga.entity_id
          WHERE ga.gift_id = g2.id
            AND (ga.entity_id IS NULL OR COALESCE(e.expects_payment, true) = true))
        THEN 'exempt'
      WHEN NOT (l.has_qb OR l.has_stripe OR l.has_dbx) THEN 'missing'
      WHEN g2.amount IS NULL THEN 'tied'
      WHEN abs(g2.amount - la.link_amt) < 0.01
        OR (g2.amount >= la.link_amt - 0.01
            AND g2.amount <= la.link_amt * 1.1 + 1) THEN 'tied'
      ELSE 'amount_mismatch'
    END AS computed
  FROM gifts_and_payments g2
  CROSS JOIN LATERAL (
    SELECT
      EXISTS (SELECT 1 FROM payment_applications p
              WHERE p.gift_id = g2.id AND p.evidence_source = 'quickbooks'
                AND p.link_role = 'counted') AS has_qb,
      EXISTS (SELECT 1 FROM payment_applications p
              WHERE p.gift_id = g2.id AND p.evidence_source = 'stripe'
                AND p.link_role = 'counted') AS has_stripe,
      EXISTS (SELECT 1 FROM payment_applications p
              WHERE p.gift_id = g2.id AND p.evidence_source = 'donorbox'
                AND p.link_role = 'counted') AS has_dbx,
      (SELECT coalesce(sum(p.amount_applied), 0) FROM payment_applications p
        WHERE p.gift_id = g2.id AND p.evidence_source = 'quickbooks'
          AND p.link_role = 'counted') AS qb_sum,
      (SELECT coalesce(sum(p.amount_applied), 0) FROM payment_applications p
        WHERE p.gift_id = g2.id AND p.evidence_source = 'stripe'
          AND p.link_role = 'counted') AS stripe_sum,
      (SELECT coalesce(sum(p.amount_applied), 0) FROM payment_applications p
        WHERE p.gift_id = g2.id AND p.evidence_source = 'donorbox'
          AND p.link_role = 'counted') AS dbx_sum
  ) l
  CROSS JOIN LATERAL (
    SELECT CASE WHEN l.has_qb THEN l.qb_sum
                WHEN l.has_stripe THEN l.stripe_sum
                WHEN l.has_dbx THEN l.dbx_sum END AS link_amt
  ) la
  WHERE EXISTS (
    SELECT 1 FROM payment_applications pc
    WHERE pc.gift_id = g2.id
      AND pc.evidence_source = 'quickbooks'
      AND pc.link_role = 'corroborating'
      AND pc.amount_applied IS NOT NULL
  )
) c
WHERE g.id = c.id
  AND g.quickbooks_tie_status IS DISTINCT FROM c.computed::gift_quickbooks_tie;

-- Verification (run after applying):
--   -- No movable counted QB row remains behind an exact-money tie
--   -- (expect 2 rows: exactly the cap-skipped pair in the RUNBOOK):
--   SELECT pa.id, pa.payment_id, pa.gift_id, pa.amount_applied
--     FROM payment_applications pa
--     JOIN stripe_staged_charges cc ON cc.linked_qb_staged_payment_id = pa.payment_id
--     JOIN staged_payments sp ON sp.id = pa.payment_id
--    WHERE pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
--      AND pa.amount_applied IS NOT NULL
--      AND (round(sp.amount*100) = round(cc.gross_amount*100)
--        OR round(sp.amount*100) = round(cc.net_amount*100));
--
--   -- The moved copies (expect 86 | 38581.42):
--   SELECT count(*), coalesce(sum(amount_applied),0)
--     FROM payment_applications WHERE id LIKE 'pacts\_%' ESCAPE '\';
--
--   -- Every copy sits on the charge its source row's QB payment is tied to
--   -- (expect 0):
--   SELECT count(*) FROM payment_applications mv
--     JOIN payment_applications src ON src.id = substr(mv.id, 7)
--     LEFT JOIN stripe_staged_charges cc
--       ON cc.id = mv.stripe_charge_id
--      AND cc.linked_qb_staged_payment_id = src.payment_id
--    WHERE mv.id LIKE 'pacts\_%' ESCAPE '\' AND cc.id IS NULL;
--
--   -- Demoted rows kept their amounts (expect >= 93 marked 'repair 0129'):
--   SELECT count(*), coalesce(sum(amount_applied),0)
--     FROM payment_applications
--    WHERE evidence_source='quickbooks' AND link_role='corroborating'
--      AND note LIKE '%repair 0129%';
--   -- expect: 93 | 40086.44
--
--   -- Tie derivation agrees with the app (spot-check the demoted gifts):
--   SELECT g.quickbooks_tie_status, count(*)
--     FROM gifts_and_payments g
--    WHERE EXISTS (SELECT 1 FROM payment_applications pc
--                   WHERE pc.gift_id = g.id AND pc.evidence_source='quickbooks'
--                     AND pc.link_role='corroborating'
--                     AND pc.note LIKE '%repair 0129%')
--    GROUP BY 1;
