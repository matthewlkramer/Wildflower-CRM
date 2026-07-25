import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { recomputeQboAccountingChecks } from "./qboAccountingRecompute";

/**
 * Forward maintenance of the bank-spine money model
 * (docs/adr-bank-spine-money-model.md): the SAME deterministic, idempotent
 * derivations the 0159–0165 backfill migrations ran once, re-run after every
 * source pull so new money flows into the spine without human action. Every
 * step is pure "fill what is missing" DML — deterministic ids + ON CONFLICT DO
 * NOTHING / NULL-only UPDATEs — so re-running is always safe and never
 * clobbers an existing row, flag, or human resolution.
 *
 * Steps (dependency order):
 *   1. bank_deposits           ← positive register lines        (0159)
 *   2. payment_units           ← non-excluded Stripe charges    (0160)
 *   3. payout → bank_deposit   ← amount/currency/date window    (0163, plus
 *      deterministic rank-pairing for equal amount/date classes with
 *      ambiguous_bank_match=true — the approved flag-not-workflow policy)
 *   4. check units+components  ← QBO deposit-composing rows     (0162)
 *   5. donorbox pointer        ← pulled charge id / human link  (0165)
 *   6. QBO accounting sidecar  ← expected-vs-actual comparer        (0166)
 *
 * Lifecycle refresh: a charge's refund/dispute facts can change after its unit
 * exists, so step 2 also re-derives lifecycle on existing stripe units.
 */
export async function recomputeBankSpine(): Promise<void> {
  // 1. Project positive bank evidence lines into bank_deposits (0159/0170).
  await db.execute(sql`
    INSERT INTO bank_deposits (
      id, source, source_bank_transaction_id, deposit_date, amount,
      currency, account, location, reference, memo
    )
    SELECT
      'bdep_' || substring(bt.id FROM 5), 'bank_csv_export', bt.id,
      bt.txn_date, bt.deposit, 'USD', bt.account, bt.location, bt.ref_no, bt.memo
    FROM bank_transactions bt
    WHERE bt.source = 'bank_csv_export'
      AND bt.deposit IS NOT NULL AND bt.deposit > 0
    ON CONFLICT (id) DO NOTHING
  `);

  // 2. One unit per non-excluded Stripe charge (0160)…
  await db.execute(sql`
    INSERT INTO payment_units (
      id, kind, stripe_charge_id, gross_amount, fee_amount, net_amount,
      currency, received_date, lifecycle
    )
    SELECT
      'pu_' || sc.id, 'stripe_charge', sc.id,
      sc.gross_amount, sc.fee_amount, sc.net_amount,
      upper(COALESCE(sc.currency, 'USD')), sc.date_received,
      CASE
        WHEN sc.disputed THEN 'disputed'
        WHEN sc.refunded THEN 'refunded'
        WHEN sc.amount_refunded IS NOT NULL AND sc.amount_refunded > 0 THEN 'partially_refunded'
        ELSE 'received'
      END::payment_unit_lifecycle
    FROM stripe_staged_charges sc
    WHERE sc.exclusion_reason IS NULL
    ON CONFLICT (id) DO NOTHING
  `);
  // …and refresh lifecycle/amount facts on existing stripe units (read-only
  // Stripe facts can change after the unit was minted).
  await db.execute(sql`
    UPDATE payment_units pu
    SET gross_amount = sc.gross_amount,
        fee_amount = sc.fee_amount,
        net_amount = sc.net_amount,
        lifecycle = CASE
          WHEN sc.disputed THEN 'disputed'
          WHEN sc.refunded THEN 'refunded'
          WHEN sc.amount_refunded IS NOT NULL AND sc.amount_refunded > 0 THEN 'partially_refunded'
          ELSE 'received'
        END::payment_unit_lifecycle,
        updated_at = now()
    FROM stripe_staged_charges sc
    WHERE sc.id = pu.stripe_charge_id
      AND (
        pu.gross_amount IS DISTINCT FROM sc.gross_amount
        OR pu.fee_amount IS DISTINCT FROM sc.fee_amount
        OR pu.net_amount IS DISTINCT FROM sc.net_amount
        OR pu.lifecycle IS DISTINCT FROM CASE
          WHEN sc.disputed THEN 'disputed'
          WHEN sc.refunded THEN 'refunded'
          WHEN sc.amount_refunded IS NOT NULL AND sc.amount_refunded > 0 THEN 'partially_refunded'
          ELSE 'received'
        END::payment_unit_lifecycle
      )
  `);

  // 2c. A charge excluded AFTER its unit was minted is non-gift money: remove
  //     the unit while nothing references it. A referenced unit is left for
  //     the parity runbook's G1b gate to surface (a human decision).
  await db.execute(sql`
    DELETE FROM payment_units pu
    USING stripe_staged_charges sc
    WHERE sc.id = pu.stripe_charge_id
      AND sc.exclusion_reason IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.payment_unit_id = pu.id)
      AND NOT EXISTS (SELECT 1 FROM bank_deposit_components c WHERE c.payment_unit_id = pu.id)
  `);

  // 3. Payout → bank deposit (0163 window; forward version greedily assigns
  //    each payout to its nearest available deposit on/after arrival). Fill-
  //    only: never rewrites an existing match.
  await db.execute(sql`
    WITH RECURSIVE
    pside AS (
      SELECT p.id, p.amount, p.arrival_date,
        upper(COALESCE(p.currency, 'USD')) AS cur,
        row_number() OVER (ORDER BY p.arrival_date, p.id) AS rn
      FROM stripe_payouts p
      WHERE p.status = 'paid' AND p.amount IS NOT NULL AND p.amount > 0
        AND p.bank_deposit_id IS NULL
    ),
    dside AS (
      SELECT d.id, d.amount, d.deposit_date, upper(d.currency) AS cur
      FROM bank_deposits d
      WHERE NOT EXISTS (SELECT 1 FROM stripe_payouts x WHERE x.bank_deposit_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM bank_deposit_components c WHERE c.bank_deposit_id = d.id)
    ),
    greedy (rn, claimed_ids, payout_id, deposit_id, ambiguous) AS (
      SELECT 0::bigint, ARRAY[]::text[], NULL::text, NULL::text, false
      UNION ALL
      SELECT
        p.rn,
        CASE
          WHEN pick.deposit_id IS NULL THEN g.claimed_ids
          ELSE g.claimed_ids || pick.deposit_id
        END,
        p.id,
        pick.deposit_id,
        COALESCE(pick.tie_count > 1, false)
      FROM greedy g
      JOIN pside p ON p.rn = g.rn + 1
      LEFT JOIN LATERAL (
        SELECT choice.deposit_id, ties.tie_count
        FROM (
          SELECT d.id AS deposit_id, d.deposit_date - p.arrival_date AS gap
          FROM dside d
          WHERE d.amount = p.amount
            AND d.cur = p.cur
            AND d.deposit_date >= p.arrival_date
            AND d.deposit_date <= p.arrival_date + 5
            AND NOT (d.id = ANY(g.claimed_ids))
          ORDER BY gap ASC, d.deposit_date ASC, d.id ASC
          LIMIT 1
        ) choice
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS tie_count
          FROM dside d2
          WHERE d2.amount = p.amount
            AND d2.cur = p.cur
            AND d2.deposit_date >= p.arrival_date
            AND d2.deposit_date <= p.arrival_date + 5
            AND d2.deposit_date - p.arrival_date = choice.gap
            AND NOT (d2.id = ANY(g.claimed_ids))
        ) ties
      ) pick ON true
    )
    UPDATE stripe_payouts p
    SET bank_deposit_id = g.deposit_id,
        ambiguous_bank_match = g.ambiguous,
        bank_matched_at = now(),
        updated_at = now()
    FROM greedy g
    WHERE p.id = g.payout_id
      AND g.deposit_id IS NOT NULL
      AND p.bank_deposit_id IS NULL
  `);

  // 4a. Provisional check/direct-payment units from QBO deposit-composing rows
  //     (0162 unit scope: not excluded, not a Stripe lump, not a split parent,
  //     not Stripe-tied, not a card-Donorbox duplicate).
  await db.execute(sql`
    WITH scope AS (
      SELECT sp.*,
        (SELECT sl.donorbox_donation_id FROM source_links sl
          WHERE sl.link_type = 'donorbox_qb' AND sl.qb_staged_payment_id = sp.id
          LIMIT 1) AS db_donation_id
      FROM staged_payments sp
      WHERE sp.qb_deposit_id IS NOT NULL
        AND sp.qb_entity_type <> 'deposit_header'
        AND sp.exclusion_reason IS NULL
        AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
        AND sp.amount IS NOT NULL AND sp.amount > 0
        AND NOT EXISTS (SELECT 1 FROM staged_payments c WHERE c.split_parent_id = sp.id)
        AND NOT EXISTS (SELECT 1 FROM source_links t
                        WHERE t.qb_staged_payment_id = sp.id
                          AND t.link_type IN ('charge_qb_tie', 'charge_fee_row'))
    ),
    units AS (
      SELECT s.*,
        CASE WHEN s.db_donation_id IS NOT NULL THEN s.db_donation_id END AS unit_donorbox_donation_id
      FROM scope s
      LEFT JOIN donorbox_donations d ON d.id = s.db_donation_id
      WHERE s.db_donation_id IS NULL
         OR NOT (d.stripe_charge_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM source_links c
                            WHERE c.donorbox_donation_id = d.id
                              AND c.link_type = 'donorbox_charge'))
    )
    INSERT INTO payment_units (
      id, kind, donorbox_donation_id, source_staged_payment_id,
      gross_amount, net_amount, currency, received_date
    )
    SELECT
      'pu_' || u.id,
      CASE
        WHEN u.funding_source = 'check' THEN 'check'
        WHEN u.funding_source = 'wire_ach' AND u.qb_payment_method ILIKE '%wire%' THEN 'wire'
        WHEN u.funding_source = 'wire_ach' THEN 'direct_ach'
        WHEN u.qb_check_number IS NOT NULL OR u.qb_payment_method ILIKE '%check%' THEN 'check'
        ELSE 'other'
      END::payment_unit_kind,
      u.unit_donorbox_donation_id,
      u.id,
      u.amount,
      u.amount,
      upper(COALESCE(u.qb_currency, 'USD')),
      u.date_received
    FROM units u
    WHERE NOT EXISTS (SELECT 1 FROM payment_units x
                      WHERE x.donorbox_donation_id = u.unit_donorbox_donation_id)
       OR u.unit_donorbox_donation_id IS NULL
    ON CONFLICT (id) DO NOTHING
  `);

  // 4b. Deposit components where the QBO Deposit pairs to a register deposit
  //     (0162 pairing: exact TotalAmt+TxnDate, rank-paired, ambiguous flagged,
  //     payout-claimed deposits excluded).
  await db.execute(sql`
    WITH scope AS (
      SELECT sp.*
      FROM staged_payments sp
      WHERE sp.qb_deposit_id IS NOT NULL
        AND sp.qb_entity_type <> 'deposit_header'
        AND sp.exclusion_reason IS NULL
        AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
        AND sp.amount IS NOT NULL AND sp.amount > 0
        AND EXISTS (SELECT 1 FROM payment_units pu WHERE pu.id = 'pu_' || sp.id)
        AND NOT EXISTS (
          SELECT 1
          FROM bank_deposit_components c
          WHERE c.payment_unit_id = 'pu_' || sp.id
        )
    ),
    depinfo AS (
      SELECT g.realm_id, g.qb_deposit_id,
        (SELECT (p.qb_raw->>'TotalAmt')::numeric FROM staged_payments p
          WHERE p.realm_id = g.realm_id AND p.qb_entity_id = g.qb_deposit_id
            AND p.qb_entity_type IN ('deposit', 'deposit_header')
            AND p.qb_raw ? 'TotalAmt'
          ORDER BY p.id LIMIT 1) AS total,
        (SELECT COALESCE((p.qb_raw->>'TxnDate')::date, p.date_received) FROM staged_payments p
          WHERE p.realm_id = g.realm_id AND p.qb_entity_id = g.qb_deposit_id
            AND p.qb_entity_type IN ('deposit', 'deposit_header')
          ORDER BY p.id LIMIT 1) AS txn_date
      FROM (SELECT DISTINCT realm_id, qb_deposit_id FROM scope) g
    ),
    qside AS (
      SELECT *,
        count(*)     OVER (PARTITION BY total, txn_date) AS class_n,
        row_number() OVER (PARTITION BY total, txn_date ORDER BY qb_deposit_id) AS rn
      FROM depinfo
      WHERE total IS NOT NULL AND txn_date IS NOT NULL
    ),
    bside AS (
      SELECT d.id, d.amount, d.deposit_date,
        count(*)     OVER (PARTITION BY d.amount, d.deposit_date) AS class_n,
        row_number() OVER (PARTITION BY d.amount, d.deposit_date ORDER BY d.id) AS rn
      FROM bank_deposits d
      WHERE NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
    ),
    pairs AS (
      SELECT q.realm_id, q.qb_deposit_id, b.id AS bank_deposit_id,
        (q.class_n > 1 OR b.class_n > 1) AS ambiguous
      FROM qside q
      JOIN bside b
        ON b.amount = q.total AND b.deposit_date = q.txn_date AND b.rn = q.rn
    )
    INSERT INTO bank_deposit_components (
      id, bank_deposit_id, payment_unit_id, amount, source,
      source_staged_payment_id, ambiguous_deposit_match, needs_review
    )
    SELECT
      'bdc_' || s.id, pr.bank_deposit_id, 'pu_' || s.id, s.amount,
      'qbo_inferred', s.id, pr.ambiguous,
      COALESCE(s.funding_source = 'paypal', false)
    FROM scope s
    JOIN pairs pr
      ON pr.realm_id = s.realm_id AND pr.qb_deposit_id = s.qb_deposit_id
    ON CONFLICT (id) DO NOTHING
  `);

  // 4c. Provisional accounting-only decomposition of QBO Deposit member
  //     lines. This deliberately includes excluded staged payments and does
  //     not require a payment_unit: it is evidence for the accounting column,
  //     never counted money. Real bank components win and are excluded by
  //     source_staged_payment_id; payout-claimed deposits stay on the Stripe
  //     authority path.
  await db.execute(sql`
    WITH scope AS (
      SELECT sp.*
      FROM staged_payments sp
      WHERE sp.qb_deposit_id IS NOT NULL
        AND sp.qb_entity_type <> 'deposit_header'
        AND sp.amount IS NOT NULL AND sp.amount > 0
        AND NOT EXISTS (SELECT 1 FROM staged_payments child WHERE child.split_parent_id = sp.id)
    ),
    depinfo AS (
      SELECT g.realm_id, g.qb_deposit_id,
        (SELECT (h.qb_raw->>'TotalAmt')::numeric
         FROM staged_payments h
         WHERE h.realm_id = g.realm_id
           AND h.qb_entity_id = g.qb_deposit_id
           AND h.qb_entity_type IN ('deposit', 'deposit_header')
           AND h.qb_raw ? 'TotalAmt'
         ORDER BY h.id LIMIT 1) AS total,
        (SELECT COALESCE((h.qb_raw->>'TxnDate')::date, h.date_received)
         FROM staged_payments h
         WHERE h.realm_id = g.realm_id
           AND h.qb_entity_id = g.qb_deposit_id
           AND h.qb_entity_type IN ('deposit', 'deposit_header')
         ORDER BY h.id LIMIT 1) AS txn_date
      FROM (SELECT DISTINCT realm_id, qb_deposit_id FROM scope) g
    ),
    qside AS (
      SELECT *,
        count(*) OVER (PARTITION BY total, txn_date) AS class_n,
        row_number() OVER (PARTITION BY total, txn_date ORDER BY realm_id, qb_deposit_id) AS rn
      FROM depinfo
      WHERE total IS NOT NULL AND txn_date IS NOT NULL
    ),
    bside AS (
      SELECT d.id, d.amount, d.deposit_date,
        count(*) OVER (PARTITION BY d.amount, d.deposit_date) AS class_n,
        row_number() OVER (PARTITION BY d.amount, d.deposit_date ORDER BY d.id) AS rn
      FROM bank_deposits d
      WHERE d.source = 'bank_csv_export'
        AND NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
    ),
    pairs AS (
      SELECT q.realm_id, q.qb_deposit_id, b.id AS bank_deposit_id,
        (q.class_n > 1 OR b.class_n > 1) AS ambiguous
      FROM qside q
      JOIN bside b
        ON b.amount = q.total
       AND b.deposit_date = q.txn_date
       AND b.rn = q.rn
    )
    INSERT INTO deposit_qbo_components (
      id, bank_deposit_id, realm_id, qb_deposit_id, staged_payment_id,
      amount, match_basis
    )
    SELECT
      'dqc_' || m.id,
      p.bank_deposit_id,
      m.realm_id,
      m.qb_deposit_id,
      m.id,
      m.amount,
      CASE WHEN p.ambiguous
        THEN 'deposit_header_ambiguous'::deposit_qbo_match_basis
        ELSE 'deposit_header_exact'::deposit_qbo_match_basis
      END
    FROM scope m
    JOIN pairs p
      ON p.realm_id = m.realm_id AND p.qb_deposit_id = m.qb_deposit_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM bank_deposit_components real_component
      WHERE real_component.source_staged_payment_id = m.id
    )
    ON CONFLICT (id) DO NOTHING
  `);

  // 5. Donorbox pointer on card units (0165): pulled charge id first, then the
  //    human donorbox_charge link. NULL-only + cardinality-guarded.
  await db.execute(sql`
    UPDATE payment_units pu
    SET donorbox_donation_id = d.id, updated_at = now()
    FROM donorbox_donations d
    WHERE pu.donorbox_donation_id IS NULL
      AND pu.stripe_charge_id IS NOT NULL
      AND d.stripe_charge_id = pu.stripe_charge_id
      AND NOT EXISTS (SELECT 1 FROM payment_units x WHERE x.donorbox_donation_id = d.id)
  `);
  await db.execute(sql`
    UPDATE payment_units pu
    SET donorbox_donation_id = sl.donorbox_donation_id, updated_at = now()
    FROM source_links sl
    WHERE pu.donorbox_donation_id IS NULL
      AND sl.link_type = 'donorbox_charge'
      AND sl.stripe_charge_id = pu.stripe_charge_id
      AND NOT EXISTS (SELECT 1 FROM payment_units x
                      WHERE x.donorbox_donation_id = sl.donorbox_donation_id)
  `);

  // 6. QBO expected-vs-actual sidecar (0166's comparer).
  await recomputeQboAccountingChecks();
}

/**
 * Best-effort wrapper for sync tails: the spine derivation must never fail a
 * source pull (the pull's own data is already committed; the recompute will
 * simply catch up on the next run).
 */
export async function recomputeBankSpineBestEffort(): Promise<void> {
  try {
    await recomputeBankSpine();
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "bank-spine recompute failed (will retry on next sync)",
    );
  }
}
