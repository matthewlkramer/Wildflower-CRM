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
 * pair it to the payout it books (human-confirmed settlement link first, else
 * unambiguous exact amount in the [arrival, +5d] bank window) and compare the
 * posted amount against the payout's net.
 *
 *   expected = { kind, payout_id, net_amount, arrival_date, bank_deposit_id, paired_by }
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
  await db.execute(sql`
    WITH lumps AS (
      SELECT sp.id, sp.amount, sp.date_received, sp.qb_deposit_to_account_name
      FROM staged_payments sp
      WHERE sp.amount IS NOT NULL AND sp.amount > 0
        AND (sp.exclusion_reason = 'processor_payout' OR sp.funding_source = 'stripe')
    ),
    -- Pairing authority 1: the human-confirmed settlement link.
    linked AS (
      SELECT l.id AS staged_id, p.id AS payout_id, 'settlement_link' AS paired_by
      FROM lumps l
      JOIN settlement_links sl
        ON sl.deposit_staged_payment_id = l.id AND sl.lifecycle = 'confirmed'
      JOIN stripe_payouts p ON p.id = sl.payout_id
    ),
    -- Pairing authority 2: unambiguous exact amount in the bank window.
    exact_cand AS (
      SELECT l.id AS staged_id, p.id AS payout_id
      FROM lumps l
      JOIN stripe_payouts p
        ON p.amount = l.amount
       AND p.status = 'paid'
       AND l.date_received >= p.arrival_date
       AND l.date_received <= p.arrival_date + INTERVAL '5 days'
      WHERE NOT EXISTS (SELECT 1 FROM linked k WHERE k.staged_id = l.id)
    ),
    exact_1to1 AS (
      SELECT staged_id, min(payout_id) AS payout_id, 'exact_amount_window' AS paired_by
      FROM exact_cand
      GROUP BY staged_id
      HAVING count(DISTINCT payout_id) = 1
    ),
    pairs AS (
      SELECT * FROM linked
      UNION ALL
      SELECT * FROM exact_1to1
    ),
    checks AS (
      SELECT
        l.id AS staged_id,
        jsonb_build_object(
          'kind', 'stripe_payout_lump',
          'payout_id', pr.payout_id,
          'net_amount', p.amount,
          'arrival_date', p.arrival_date,
          'bank_deposit_id', p.bank_deposit_id,
          'paired_by', pr.paired_by
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
      FROM lumps l
      JOIN pairs pr ON pr.staged_id = l.id
      JOIN stripe_payouts p ON p.id = pr.payout_id
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
