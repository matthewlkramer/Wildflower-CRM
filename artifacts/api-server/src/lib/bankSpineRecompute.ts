import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

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
 *   6. ledger annotation       ← payment_applications.payment_unit_id (0164)
 *
 * Lifecycle refresh: a charge's refund/dispute facts can change after its unit
 * exists, so step 2 also re-derives lifecycle on existing stripe units.
 */
export async function recomputeBankSpine(): Promise<void> {
  // 1. Project new positive register lines into bank_deposits (0159).
  await db.execute(sql`
    INSERT INTO bank_deposits (
      id, source, source_bank_transaction_id, deposit_date, amount,
      currency, account, location, reference, memo
    )
    SELECT
      'bdep_' || substring(bt.id FROM 5), 'qbo_register_export', bt.id,
      bt.txn_date, bt.deposit, 'USD', bt.account, bt.location, bt.ref_no, bt.memo
    FROM bank_transactions bt
    WHERE bt.source = 'qbo_register_export'
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

  // 3. Payout → bank deposit (0163 window; forward version pairs equal
  //    amount/date classes deterministically by rank and FLAGS them instead of
  //    leaving them unmatched). Fill-only: never rewrites an existing match.
  await db.execute(sql`
    WITH pside AS (
      SELECT p.id, p.amount, p.arrival_date,
        upper(COALESCE(p.currency, 'USD')) AS cur,
        count(*)     OVER (PARTITION BY p.amount, p.arrival_date) AS class_n,
        row_number() OVER (PARTITION BY p.amount, p.arrival_date ORDER BY p.id) AS rn
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
    cand AS (
      SELECT p.id AS payout_id, d.id AS deposit_id, p.class_n, p.rn
      FROM pside p
      JOIN dside d
        ON d.amount = p.amount AND d.cur = p.cur
       AND d.deposit_date >= p.arrival_date
       AND d.deposit_date <= p.arrival_date + INTERVAL '5 days'
    ),
    ranked AS (
      SELECT payout_id, deposit_id, class_n, rn,
        row_number() OVER (PARTITION BY payout_id ORDER BY deposit_id) AS drn,
        count(*)     OVER (PARTITION BY payout_id) AS dn,
        count(*)     OVER (PARTITION BY deposit_id) AS pn
      FROM cand
    ),
    pick AS (
      -- Deterministic pairing: the nth payout of an equal class takes the nth
      -- candidate deposit; ambiguous when either side had >1 possibility.
      SELECT DISTINCT ON (deposit_id)
        payout_id, deposit_id, (class_n > 1 OR dn > 1 OR pn > 1) AS ambiguous
      FROM ranked
      WHERE drn = LEAST(rn, dn)
      ORDER BY deposit_id, payout_id
    )
    UPDATE stripe_payouts p
    SET bank_deposit_id = k.deposit_id,
        ambiguous_bank_match = k.ambiguous,
        bank_matched_at = now(),
        updated_at = now()
    FROM pick k
    WHERE p.id = k.payout_id AND p.bank_deposit_id IS NULL
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

  // 6. Annotate ledger rows that predate their unit (0164). The forward writer
  //    (applyPaymentApplication) sets payment_unit_id inline; this catch-up
  //    covers rows written before this recompute minted the unit.
  await db.execute(sql`
    UPDATE payment_applications pa
    SET payment_unit_id = pu.id, updated_at = now()
    FROM payment_units pu
    WHERE pa.payment_unit_id IS NULL
      AND pa.stripe_charge_id IS NOT NULL
      AND pu.stripe_charge_id = pa.stripe_charge_id
  `);
  await db.execute(sql`
    UPDATE payment_applications pa
    SET payment_unit_id = pu.id, updated_at = now()
    FROM payment_units pu
    WHERE pa.payment_unit_id IS NULL
      AND pa.payment_id IS NOT NULL
      AND pu.source_staged_payment_id = pa.payment_id
  `);
  await db.execute(sql`
    UPDATE payment_applications pa
    SET payment_unit_id = pu.id, updated_at = now()
    FROM payment_units pu
    WHERE pa.payment_unit_id IS NULL
      AND pa.donorbox_donation_id IS NOT NULL
      AND pu.donorbox_donation_id = pa.donorbox_donation_id
  `);
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
