import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * QBO expected-vs-actual accounting comparer (docs/adr-bank-spine-money-model.md
 * §accounting sidecar, Phase 7 table / Phase 9 writer). QBO is downstream: the
 * spine (payouts, bank deposits, payment units) states what SHOULD be posted;
 * this pass compares that expectation against the actual QBO records and writes
 * one `qbo_accounting_checks` row per checked QBO row.
 *
 * v1 scope — Stripe payout lumps. Wildflower has historically booked these
 * inconsistently: sometimes at payout NET and sometimes at charge GROSS, with
 * fees handled elsewhere. Until fee-line documentation is modeled, either
 * amount is accepted as complete. `booking_basis` records which convention was
 * detected; only an amount matching neither gross nor net is a correction.
 *
 * Pairing FACT is the `payout_qb_settlement` source_link. This pass first FILLS
 * it for unpaired lumps with an unambiguous exact-amount payout in the
 * [arrival, +5d] bank window (fill-only, never re-points), then compares every
 * paired lump.
 *
 * Idempotent + human-safe: rows a human resolved (any row with
 * resolved_by_user_id, and `accepted_historical`) are never touched; machine
 * rows are refreshed in place as pairings/facts change. A row that was
 * `correction_needed` and now compares clean flips to `corrected`.
 */
export async function recomputeQboAccountingChecks(): Promise<void> {
  // 1. Fill pairing facts for unpaired lumps. A QBO row may match either the
  // payout net or gross amount; both conventions are legitimate historical
  // booking patterns. Require a unique candidate and never re-point an existing
  // relationship.
  await db.execute(sql`
    WITH lumps AS (
      SELECT sp.id, sp.amount, sp.date_received
      FROM staged_payments sp
      WHERE sp.amount IS NOT NULL AND sp.amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'payout_qb_settlement'
            AND sl.qb_staged_payment_id = sp.id
        )
        AND (sp.exclusion_reason = 'processor_payout' OR sp.funding_source = 'stripe')
    ),
    exact_cand AS (
      SELECT l.id AS staged_id, p.id AS payout_id
      FROM lumps l
      JOIN stripe_payouts p
        ON (p.amount = l.amount OR p.gross_total = l.amount)
       AND p.status = 'paid'
       AND l.date_received >= p.arrival_date
       AND l.date_received <= p.arrival_date + INTERVAL '5 days'
      WHERE NOT EXISTS (SELECT 1 FROM source_links t
                        WHERE t.link_type = 'payout_qb_settlement'
                          AND t.stripe_payout_id = p.id)
    ),
    exact_1to1 AS (
      SELECT staged_id, min(payout_id) AS payout_id
      FROM exact_cand
      GROUP BY staged_id
      HAVING count(DISTINCT payout_id) = 1
    ),
    payout_1to1 AS (
      SELECT payout_id, min(staged_id) AS staged_id
      FROM exact_1to1
      GROUP BY payout_id
      HAVING count(*) = 1
    )
    INSERT INTO source_links (
      id, link_type, qb_staged_payment_id, stripe_payout_id,
      lifecycle, provenance, match_basis
    )
    SELECT
      'srcl_pqs_' || m.payout_id, 'payout_qb_settlement',
      m.staged_id, m.payout_id, 'confirmed', 'system', 'settled_pairing'
    FROM payout_1to1 m
    ON CONFLICT (id) DO NOTHING
  `);

  // 2. Compare every paired lump. Net wins when gross and net happen to be
  // equal; otherwise the basis is whichever amount matches within one cent.
  await db.execute(sql`
    WITH checks AS (
      SELECT
        l.id AS staged_id,
        jsonb_build_object(
          'kind', 'stripe_payout_lump',
          'payout_id', p.id,
          'net_amount', p.amount,
          'gross_amount', p.gross_total,
          'arrival_date', p.arrival_date,
          'bank_deposit_id', p.bank_deposit_id
        ) AS expected,
        jsonb_build_object(
          'amount', l.amount,
          'date_received', l.date_received,
          'account', l.qb_deposit_to_account_name
        ) AS actual,
        CASE
          WHEN abs(l.amount - p.amount) <= 0.01 THEN 'net'
          WHEN p.gross_total IS NOT NULL AND abs(l.amount - p.gross_total) <= 0.01 THEN 'gross'
          ELSE 'unmatched'
        END AS booking_basis,
        CASE
          WHEN abs(l.amount - p.amount) <= 0.01 THEN 'consistent'
          WHEN p.gross_total IS NOT NULL AND abs(l.amount - p.gross_total) <= 0.01 THEN 'consistent'
          ELSE 'correction_needed'
        END::qbo_accounting_disposition AS disposition,
        CASE
          WHEN abs(l.amount - p.amount) <= 0.01 THEN NULL
          WHEN p.gross_total IS NOT NULL AND abs(l.amount - p.gross_total) <= 0.01 THEN NULL
          ELSE 'QBO posts ' || l.amount || ', but payout net is ' || p.amount ||
               CASE WHEN p.gross_total IS NULL THEN ''
                    ELSE ' and payout gross is ' || p.gross_total END
        END AS note
      FROM staged_payments l
      JOIN source_links sl
        ON sl.link_type = 'payout_qb_settlement'
       AND sl.qb_staged_payment_id = l.id
      JOIN stripe_payouts p ON p.id = sl.stripe_payout_id
    )
    INSERT INTO qbo_accounting_checks (
      id, staged_payment_id, expected, actual, disposition, booking_basis,
      note, computed_at
    )
    SELECT 'qac_' || c.staged_id, c.staged_id, c.expected, c.actual,
           c.disposition, c.booking_basis, c.note, now()
    FROM checks c
    ON CONFLICT (staged_payment_id) DO UPDATE SET
      expected = excluded.expected,
      actual = excluded.actual,
      booking_basis = excluded.booking_basis,
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
