import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * QBO expected-vs-actual accounting comparer (docs/adr-bank-spine-money-model.md
 * §accounting sidecar, Phase 7 table / Phase 9 writer). QBO is downstream: the
 * spine (payouts, bank deposits, payment units) states what SHOULD be posted;
 * this pass compares that expectation against the actual QBO records and writes
 * one `qbo_accounting_checks` row per checked QBO row.
 *
 * v1 scope — Stripe payout lumps, the highest-risk posting (net lump amounts,
 * known bookkeeping errors): for each QBO deposit row claiming Stripe money,
 * pair it to the payout it books and compare the posted amount against the
 * payout's net. The pairing FACT is `staged_payments.settled_stripe_payout_id`
 * (0168 — seeded from the retired settlement_links confirmations): this pass
 * first FILLS it for unpaired lumps with an unambiguous exact-amount payout in
 * the [arrival, +5d] bank window (fill-only, never re-points), then compares
 * every paired lump.
 *
 *   expected = { kind, payout_id, net_amount, arrival_date, bank_deposit_id }
 *   actual   = { amount, date_received, account }
 *   disposition: consistent | correction_needed (machine states)
 *
 * Idempotent + human-safe: rows a human resolved (any row with
 * resolved_by_user_id, and `accepted_historical`) are never touched; machine
 * rows are refreshed in place as pairings/facts change. A row that was
 * `correction_needed` and now compares clean flips to `corrected` (the fix
 * happened in QBO; the sidecar records that it was fixed, not that it was
 * always fine).
 */
export async function recomputeQboAccountingChecks(): Promise<void> {
  // 1. Fill the pairing fact for unpaired lumps with an unambiguous
  //    exact-amount payout in the bank window. Fill-only: an existing pairing
  //    (human-confirmed 0168 backfill or an earlier pass) is never re-pointed,
  //    and a payout already claimed by another lump is never re-used.
  await db.execute(sql`
    WITH lumps AS (
      SELECT sp.id, sp.amount, sp.date_received
      FROM staged_payments sp
      WHERE sp.amount IS NOT NULL AND sp.amount > 0
        AND sp.settled_stripe_payout_id IS NULL
        AND (sp.exclusion_reason = 'processor_payout' OR sp.funding_source = 'stripe')
    ),
    exact_cand AS (
      SELECT l.id AS staged_id, p.id AS payout_id
      FROM lumps l
      JOIN stripe_payouts p
        ON p.amount = l.amount
       AND p.status = 'paid'
       AND l.date_received >= p.arrival_date
       AND l.date_received <= p.arrival_date + INTERVAL '5 days'
      WHERE NOT EXISTS (SELECT 1 FROM staged_payments t
                        WHERE t.settled_stripe_payout_id = p.id)
    ),
    exact_1to1 AS (
      SELECT staged_id, min(payout_id) AS payout_id
      FROM exact_cand
      GROUP BY staged_id
      HAVING count(DISTINCT payout_id) = 1
    ),
    -- One payout must not pair to two lumps within this pass either.
    payout_1to1 AS (
      SELECT payout_id, min(staged_id) AS staged_id
      FROM exact_1to1
      GROUP BY payout_id
      HAVING count(*) = 1
    )
    UPDATE staged_payments sp
    SET settled_stripe_payout_id = m.payout_id, updated_at = now()
    FROM payout_1to1 m
    WHERE sp.id = m.staged_id
      AND sp.settled_stripe_payout_id IS NULL
  `);

  // 2. Compare every paired lump.
  await db.execute(sql`
    WITH checks AS (
      SELECT
        l.id AS staged_id,
        jsonb_build_object(
          'kind', 'stripe_payout_lump',
          'payout_id', p.id,
          'net_amount', p.amount,
          'arrival_date', p.arrival_date,
          'bank_deposit_id', p.bank_deposit_id
        ) AS expected,
        jsonb_build_object(
          'amount', l.amount,
          'date_received', l.date_received,
          'account', l.qb_deposit_to_account_name
        ) AS actual,
        CASE
          WHEN abs(l.amount - p.amount) <= 0.01 THEN 'consistent'
          ELSE 'correction_needed'
        END::qbo_accounting_disposition AS disposition,
        CASE
          WHEN abs(l.amount - p.amount) <= 0.01 THEN NULL
          ELSE 'QBO posts ' || l.amount || ' but the payout net is ' || p.amount
        END AS note
      FROM staged_payments l
      JOIN stripe_payouts p ON p.id = l.settled_stripe_payout_id
    )
    INSERT INTO qbo_accounting_checks (
      id, staged_payment_id, expected, actual, disposition, note, computed_at
    )
    SELECT 'qac_' || c.staged_id, c.staged_id, c.expected, c.actual,
           c.disposition, c.note, now()
    FROM checks c
    ON CONFLICT (staged_payment_id) DO UPDATE SET
      expected = excluded.expected,
      actual = excluded.actual,
      -- A clean re-compare on a row that needed (or received) a fix records
      -- 'corrected' — the sidecar remembers it was fixed, not that it was
      -- always fine.
      disposition = CASE
        WHEN excluded.disposition = 'consistent'
         AND qbo_accounting_checks.disposition IN ('correction_needed', 'corrected')
        THEN 'corrected'::qbo_accounting_disposition
        ELSE excluded.disposition
      END,
      note = excluded.note,
      computed_at = now(),
      updated_at = now()
    WHERE qbo_accounting_checks.resolved_by_user_id IS NULL
      AND qbo_accounting_checks.disposition IN
        ('consistent', 'correction_needed', 'corrected')
  `);
}
