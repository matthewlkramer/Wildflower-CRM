-- 0125 — Retro-apply §4.3 settlement supersede: demote double-counted QB rows,
--        book the one pointer-without-ledger deposit, clear stale conflict
--        crumbs, re-derive quickbooks_tie_status.
--
-- Context (prod audit, 2026-07-14): before applySettlementSupersedeMany
-- existed, confirming a deposit↔payout settlement link did NOT demote the
-- deposit's coarse counted QB row when the same money was also booked as
-- per-charge counted Stripe rows. Result: 57 gifts carry BOTH a counted QB
-- deposit row AND covering counted Stripe rows from the confirmed-settled
-- payout — $20,822.13 of the same dollars counted twice by source-agnostic
-- SUM readers (settledGrossForGift etc.). This file applies exactly the
-- decision the app's supersede module (settlementSupersede.ts,
-- decideSupersedeActions) now makes on every new confirm/booking:
--
--   counted QB row + CONFIRMED settlement link on its deposit + the linked
--   payout's counted Stripe rows for the SAME gift sum within the processor
--   fee band (equal to the cent, or gross in [net-0.01, net*1.1+1])
--     → demote to `corroborating`, KEEPING the amount (supersede-managed;
--       fully reversible by the app if the coverage fact goes away).
--
-- Also fixed here:
--   - D1: deposit RS4FYIjvOXsVBv1dX_UEL ($479.20 Stripe payout lump,
--     2020-12-24) carries a matched pointer to gift rec9XBJx3rV5PtdJb but has
--     ZERO ledger rows (pointer-era match, never booked). Its money IS the
--     $500 charge ch_1I0ybNAhXr9x8yiR73JwEriA (net 479.20) already counted on
--     the gift, and the settlement link sl_po_1I1M8UAhXr9x8yiRtITT7LoX is
--     confirmed — so the converged state is the DEMOTED shape: a
--     corroborating QB row for the deposit amount. Inserted directly.
--   - 38 stale settlement_links.conflict_gift_id crumbs whose "kept gift" is
--     per-charge booked from that same payout (same rationale as 0123/0124:
--     the money trail is the per-charge rows; the crumb blocks per-charge
--     mint paths and shows a false trail). The 4 other crumbs stay: their
--     gifts have no counted Stripe rows from the linked payout, so the crumb
--     still records a genuine keep-the-QB-gift resolution.
--
-- NOT fixed here (needs a human decision — see the RUNBOOK's review list):
--   9 pure-duplicate gifts ($808.85) whose deposits have NO confirmed
--   settlement link; confirm each deposit↔payout in the Finance
--   Reconciliation workbench and the app's supersede will demote them.
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0125_demote_double_counted_qb_rows_settlement_supersede.sql
--
-- Safety / idempotency:
--   - Every statement is guarded on current facts (link_role='counted',
--     confirmed link, fee-band coverage), so a re-run — or running after the
--     app's own supersede already converged some deposits — is a no-op for
--     the already-converged rows. Expected first-run counts are in the
--     RUNBOOK; re-run: all zeros.
--   - The demote predicate is byte-for-byte the app's rule
--     (decideSupersedeActions + amountWithinFeeBand QB-only band), so the
--     app's next supersede pass agrees with every row this file touches.
--   - Corrections-flow corroborating rows (amount_applied IS NULL) are never
--     touched (supersede discriminator).
--   - No BEGIN/COMMIT here — psql -1 wraps the file in one transaction.

-- 1) Clear any pre-existing corroborating row that would collide with a
--    demotion on the partial UNIQUE (payment_id, gift_id) WHERE
--    corroborating — mirrors the app's demote path. (Prod audit found zero
--    corroborating rows, so this expects 0; kept for exact-mirror safety.)
DELETE FROM payment_applications victim
WHERE victim.link_role = 'corroborating'
  AND victim.evidence_source = 'quickbooks'
  AND EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.payment_id = victim.payment_id
      AND pa.gift_id = victim.gift_id
      AND pa.id <> victim.id
      AND pa.evidence_source = 'quickbooks'
      AND pa.link_role = 'counted'
      AND (
        SELECT coalesce(sum(spa.amount_applied), 0)
        FROM payment_applications spa
        JOIN stripe_staged_charges ssc ON ssc.id = spa.stripe_charge_id
        WHERE spa.evidence_source = 'stripe'
          AND spa.link_role = 'counted'
          AND spa.gift_id = pa.gift_id
          AND ssc.stripe_payout_id IN (
            SELECT sl.payout_id FROM settlement_links sl
            WHERE sl.deposit_staged_payment_id = pa.payment_id
              AND sl.lifecycle = 'confirmed')
      ) > 0
      AND (
        SELECT coalesce(sum(spa.amount_applied), 0)
        FROM payment_applications spa
        JOIN stripe_staged_charges ssc ON ssc.id = spa.stripe_charge_id
        WHERE spa.evidence_source = 'stripe'
          AND spa.link_role = 'counted'
          AND spa.gift_id = pa.gift_id
          AND ssc.stripe_payout_id IN (
            SELECT sl.payout_id FROM settlement_links sl
            WHERE sl.deposit_staged_payment_id = pa.payment_id
              AND sl.lifecycle = 'confirmed')
      ) BETWEEN pa.amount_applied - 0.01 AND pa.amount_applied * 1.1 + 1
  );

-- 2) THE DEMOTE (expected: 57 rows, $20,822.13). Counted QB deposit rows
--    whose money is re-expressed by the confirmed-settled payout's counted
--    per-charge Stripe rows for the same gift, within the fee band.
--    Amount is KEPT (supersede-managed corroborating row; the CHECK allows
--    amount > 0 on corroborating rows).
UPDATE payment_applications pa
SET link_role  = 'corroborating',
    note       = coalesce(pa.note || ' | ', '')
                 || 'repair 0125: demoted to corroborating — money re-expressed by the per-charge counted Stripe rows of the confirmed-settled payout (retroactive settlement supersede)',
    updated_at = now()
WHERE pa.evidence_source = 'quickbooks'
  AND pa.link_role = 'counted'
  AND (
    SELECT coalesce(sum(spa.amount_applied), 0)
    FROM payment_applications spa
    JOIN stripe_staged_charges ssc ON ssc.id = spa.stripe_charge_id
    WHERE spa.evidence_source = 'stripe'
      AND spa.link_role = 'counted'
      AND spa.gift_id = pa.gift_id
      AND ssc.stripe_payout_id IN (
        SELECT sl.payout_id FROM settlement_links sl
        WHERE sl.deposit_staged_payment_id = pa.payment_id
          AND sl.lifecycle = 'confirmed')
  ) > 0
  AND (
    -- amountWithinFeeBand(evidence = QB row amount, gift = Stripe sum),
    -- QB-only fallback: equal to the cent OR within the fee band above net.
    SELECT abs(s.total - pa.amount_applied) < 0.01
           OR s.total BETWEEN pa.amount_applied - 0.01
                          AND pa.amount_applied * 1.1 + 1
    FROM (
      SELECT coalesce(sum(spa.amount_applied), 0) AS total
      FROM payment_applications spa
      JOIN stripe_staged_charges ssc ON ssc.id = spa.stripe_charge_id
      WHERE spa.evidence_source = 'stripe'
        AND spa.link_role = 'counted'
        AND spa.gift_id = pa.gift_id
        AND ssc.stripe_payout_id IN (
          SELECT sl.payout_id FROM settlement_links sl
          WHERE sl.deposit_staged_payment_id = pa.payment_id
            AND sl.lifecycle = 'confirmed')
    ) s
  );

-- 3) D1: book the missing ledger row for deposit RS4FYIjvOXsVBv1dX_UEL
--    directly in its converged DEMOTED shape (corroborating, deposit amount
--    479.20). The gift's money trail stays the counted $500 Stripe charge
--    row; this row records the deposit-level settlement without
--    double-counting. Guarded on the exact pointer-without-ledger state.
INSERT INTO payment_applications
  (id, payment_id, gift_id, amount_applied, evidence_source, match_method,
   link_role, lifecycle, confirmed_by_user_id, confirmed_at, note,
   created_the_gift, created_at, updated_at)
SELECT
  'pa_repair0125_walker47920', 'RS4FYIjvOXsVBv1dX_UEL', 'rec9XBJx3rV5PtdJb',
  479.20, 'quickbooks', 'system_confirmed', 'corroborating', 'confirmed',
  NULL, now(),
  'repair 0125: backfills the never-booked ledger row for this pointer-era matched deposit, directly in its demoted (corroborating) shape — the money is counted via Stripe charge ch_1I0ybNAhXr9x8yiR73JwEriA',
  false, now(), now()
WHERE NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.payment_id = 'RS4FYIjvOXsVBv1dX_UEL'
  )
  AND EXISTS (
    SELECT 1 FROM staged_payments sp
    WHERE sp.id = 'RS4FYIjvOXsVBv1dX_UEL'
      AND sp.amount = 479.20
      AND sp.matched_gift_id = 'rec9XBJx3rV5PtdJb'
      AND sp.match_status = 'matched'
  )
  AND EXISTS (
    SELECT 1 FROM settlement_links sl
    WHERE sl.deposit_staged_payment_id = 'RS4FYIjvOXsVBv1dX_UEL'
      AND sl.payout_id = 'po_1I1M8UAhXr9x8yiRtITT7LoX'
      AND sl.lifecycle = 'confirmed'
  )
  AND EXISTS (
    SELECT 1 FROM payment_applications spa
    WHERE spa.gift_id = 'rec9XBJx3rV5PtdJb'
      AND spa.stripe_charge_id = 'ch_1I0ybNAhXr9x8yiR73JwEriA'
      AND spa.evidence_source = 'stripe'
      AND spa.link_role = 'counted'
  )
  AND EXISTS (
    SELECT 1 FROM gifts_and_payments g
    WHERE g.id = 'rec9XBJx3rV5PtdJb' AND g.archived_at IS NULL
  );

-- 4) Clear stale conflict crumbs (expected: 38 of 42) on CONFIRMED settlement
--    links whose "kept gift" is per-charge booked from that same payout —
--    with the money booked per-charge the link is a plain settlement-only
--    confirm (0123/0124 precedent). The other 4 crumbs record genuine
--    keep-the-QB-gift resolutions (no counted Stripe rows from the payout)
--    and are left alone.
UPDATE settlement_links sl
SET conflict_gift_id = NULL,
    updated_at       = now()
WHERE sl.conflict_gift_id IS NOT NULL
  AND sl.lifecycle = 'confirmed'
  AND EXISTS (
    SELECT 1 FROM payment_applications spa
    JOIN stripe_staged_charges ssc ON ssc.id = spa.stripe_charge_id
    WHERE spa.gift_id = sl.conflict_gift_id
      AND spa.evidence_source = 'stripe'
      AND spa.link_role = 'counted'
      AND ssc.stripe_payout_id = sl.payout_id
  );

-- 5) Re-derive quickbooks_tie_status (mirrors applyGiftQbTieMany /
--    deriveGiftQbTie) for every gift now holding a supersede-managed
--    corroborating QB row (amount NOT NULL) — exactly the demoted gifts +
--    the D1 gift. Per-source PRECEDENCE (QB counted sum wins, else Stripe,
--    else Donorbox — never a cross-source SUM); off-books gifts are exempt;
--    band = amountWithinFeeBand(evidence = link sum, gift = gift amount).
--    Guarded on IS DISTINCT FROM, so a re-run updates 0 rows.
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
--   -- No double-counted gift remains behind a CONFIRMED settlement link:
--   --   expect 0 rows
--   SELECT pa.gift_id, pa.payment_id, pa.amount_applied
--     FROM payment_applications pa
--    WHERE pa.evidence_source = 'quickbooks' AND pa.link_role = 'counted'
--      AND EXISTS (SELECT 1 FROM settlement_links sl
--                   WHERE sl.deposit_staged_payment_id = pa.payment_id
--                     AND sl.lifecycle = 'confirmed')
--      AND (SELECT coalesce(sum(spa.amount_applied),0)
--             FROM payment_applications spa
--             JOIN stripe_staged_charges ssc ON ssc.id = spa.stripe_charge_id
--            WHERE spa.evidence_source='stripe' AND spa.link_role='counted'
--              AND spa.gift_id = pa.gift_id
--              AND ssc.stripe_payout_id IN (
--                SELECT sl.payout_id FROM settlement_links sl
--                WHERE sl.deposit_staged_payment_id = pa.payment_id
--                  AND sl.lifecycle='confirmed'))
--          BETWEEN pa.amount_applied - 0.01 AND pa.amount_applied * 1.1 + 1;
--
--   -- Demoted rows kept their amounts (expect 58: 57 demoted + 1 D1 row):
--   SELECT count(*), coalesce(sum(amount_applied),0)
--     FROM payment_applications
--    WHERE evidence_source='quickbooks' AND link_role='corroborating'
--      AND amount_applied IS NOT NULL;
--   -- expect: 58 | 21301.33  (20822.13 + 479.20)
--
--   -- D1 deposit now has exactly its corroborating row:
--   SELECT id, payment_id, gift_id, amount_applied, link_role, lifecycle
--     FROM payment_applications WHERE payment_id = 'RS4FYIjvOXsVBv1dX_UEL';
--
--   -- Crumbs: 4 remain, all on links whose kept gift has no per-charge rows:
--   SELECT count(*) FROM settlement_links WHERE conflict_gift_id IS NOT NULL;
--   -- expect: 4
--
--   -- Tie derivation agrees with the app (spot-check the demoted gifts):
--   SELECT g.quickbooks_tie_status, count(*)
--     FROM gifts_and_payments g
--    WHERE EXISTS (SELECT 1 FROM payment_applications pc
--                   WHERE pc.gift_id = g.id AND pc.evidence_source='quickbooks'
--                     AND pc.link_role='corroborating'
--                     AND pc.amount_applied IS NOT NULL)
--    GROUP BY 1;
