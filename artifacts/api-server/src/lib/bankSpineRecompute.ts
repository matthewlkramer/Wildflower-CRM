import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { applyDerivedOppFieldsMany } from "./pledgeStage";
import { recomputeQboAccountingChecks } from "./qboAccountingRecompute";

/**
 * Cross-process serialization for the recompute: two concurrent runs bulk-
 * insert the SAME deterministic ids (e.g. 'pu_' || charge id) in different
 * scan orders, so they can deadlock each other on index/FK waits (observed
 * under overlapping sync tails and parallel test workers). A session-level
 * advisory lock held on a dedicated connection makes later callers queue —
 * the recompute is idempotent source-refresh/fill DML, so running back-to-back
 * is always safe and never loses review work.
 */
const BANK_SPINE_ADVISORY_LOCK_KEY = 728411001;

type QboDepositLineMergeCandidate = {
  source_link_id: string;
  staged_payment_id: string;
  bank_deposit_id: string;
  component_id: string;
  target_unit_id: string;
  auto_unit_id: string;
};

/**
 * Refresh the source-owned money facts of QBO-derived direct-payment units and
 * components. `staged_payments` is the QBO mirror; once a Deposit line is
 * edited, its deterministic payment unit must not retain the first-seen
 * amount. The component is refreshed only when QBO is still its declared
 * source — manual/bank-native components remain human-owned.
 */
async function refreshQboDerivedDirectPaymentFacts(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE payment_units pu
      SET kind = CASE
            WHEN sp.funding_source = 'check' THEN 'check'
            WHEN sp.funding_source = 'wire_ach'
              AND sp.qb_payment_method ILIKE '%wire%' THEN 'wire'
            WHEN sp.funding_source = 'wire_ach' THEN 'direct_ach'
            WHEN sp.qb_check_number IS NOT NULL
              OR sp.qb_payment_method ILIKE '%check%' THEN 'check'
            ELSE 'other'
          END::payment_unit_kind,
          gross_amount = sp.amount,
          net_amount = sp.amount,
          currency = upper(COALESCE(sp.qb_currency, 'USD')),
          received_date = sp.date_received,
          updated_at = now()
      FROM staged_payments sp
      WHERE pu.source_staged_payment_id = sp.id
        AND pu.stripe_charge_id IS NULL
        AND sp.qb_deposit_id IS NOT NULL
        AND sp.qb_entity_type <> 'deposit_header'
        AND sp.exclusion_reason IS NULL
        AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
        AND sp.amount IS NOT NULL
        AND sp.amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM staged_payments child
          WHERE child.split_parent_id = sp.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_links tie
          WHERE tie.qb_staged_payment_id = sp.id
            AND tie.link_type IN ('charge_qb_tie', 'charge_fee_row')
        )
        AND (
          pu.kind IS DISTINCT FROM CASE
            WHEN sp.funding_source = 'check' THEN 'check'
            WHEN sp.funding_source = 'wire_ach'
              AND sp.qb_payment_method ILIKE '%wire%' THEN 'wire'
            WHEN sp.funding_source = 'wire_ach' THEN 'direct_ach'
            WHEN sp.qb_check_number IS NOT NULL
              OR sp.qb_payment_method ILIKE '%check%' THEN 'check'
            ELSE 'other'
          END::payment_unit_kind
          OR pu.gross_amount IS DISTINCT FROM sp.amount
          OR pu.net_amount IS DISTINCT FROM sp.amount
          OR pu.currency IS DISTINCT FROM upper(COALESCE(sp.qb_currency, 'USD'))
          OR pu.received_date IS DISTINCT FROM sp.date_received
        )
    `);

    await tx.execute(sql`
      UPDATE bank_deposit_components component
      SET amount = sp.amount,
          updated_at = now()
      FROM staged_payments sp
      WHERE component.source = 'qbo_inferred'
        AND component.source_staged_payment_id = sp.id
        AND sp.exclusion_reason IS NULL
        AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
        AND sp.amount IS NOT NULL
        AND sp.amount > 0
        AND component.amount IS DISTINCT FROM sp.amount
    `);
  });
}

/**
 * Carry an existing unit→gift tie across the one unambiguous QBO re-split
 * shape. QuickBooks often changes one already-reconciled Deposit line into
 * several same-payer lines solely to document allocation-level accounting.
 * Those rows are several payment units funding ONE multi-allocation gift, not
 * a request to create an additional gift.
 *
 * The inference is intentionally narrow: every component must be a live,
 * reviewed, non-ambiguous QBO component from one QBO Deposit; every current
 * source line must be represented; the same non-empty payer must appear on all
 * lines; component total, bank deposit, and the sole already-linked gift must
 * agree to the cent. Anything less certain remains visible for human review.
 */
async function carryGiftAcrossUnambiguousQboDepositSplit(): Promise<string[]> {
  const result = await db.execute(sql`
    WITH component_rows AS MATERIALIZED (
      SELECT
        component.bank_deposit_id,
        component.payment_unit_id,
        component.amount,
        unit.gift_id,
        sp.realm_id,
        sp.qb_deposit_id,
        NULLIF(
          lower(regexp_replace(trim(sp.payer_name), '\\s+', ' ', 'g')),
          ''
        ) AS payer_key
      FROM bank_deposit_components component
      JOIN payment_units unit ON unit.id = component.payment_unit_id
      JOIN staged_payments sp ON sp.id = component.source_staged_payment_id
      WHERE component.source = 'qbo_inferred'
        AND component.source_staged_payment_id IS NOT NULL
        AND component.exclusion_reason IS NULL
        AND NOT component.needs_review
        AND NOT component.ambiguous_deposit_match
        AND sp.qb_deposit_id IS NOT NULL
        AND sp.qb_entity_type <> 'deposit_header'
        AND sp.exclusion_reason IS NULL
        AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
        AND sp.amount IS NOT NULL
        AND sp.amount > 0
        AND component.amount = sp.amount
        AND unit.gross_amount = component.amount
        AND unit.net_amount = component.amount
    ),
    grouped AS (
      SELECT
        rows.bank_deposit_id,
        rows.realm_id,
        rows.qb_deposit_id,
        min(rows.gift_id) FILTER (WHERE rows.gift_id IS NOT NULL) AS gift_id,
        count(*)::int AS component_count,
        count(*) FILTER (WHERE rows.gift_id IS NOT NULL)::int AS linked_count,
        count(*) FILTER (WHERE rows.gift_id IS NULL)::int AS unlinked_count,
        count(DISTINCT rows.gift_id)
          FILTER (WHERE rows.gift_id IS NOT NULL)::int AS gift_count,
        count(*) FILTER (WHERE rows.payer_key IS NULL)::int AS missing_payer_count,
        count(DISTINCT rows.payer_key)::int AS payer_count,
        sum(rows.amount) AS component_total
      FROM component_rows rows
      GROUP BY rows.bank_deposit_id, rows.realm_id, rows.qb_deposit_id
    ),
    eligible AS (
      SELECT grouped.bank_deposit_id, grouped.realm_id,
             grouped.qb_deposit_id, grouped.gift_id
      FROM grouped
      JOIN bank_deposits deposit ON deposit.id = grouped.bank_deposit_id
      JOIN gifts_and_payments gift ON gift.id = grouped.gift_id
      WHERE grouped.component_count >= 2
        AND grouped.linked_count >= 1
        AND grouped.unlinked_count >= 1
        AND grouped.gift_count = 1
        AND grouped.missing_payer_count = 0
        AND grouped.payer_count = 1
        AND abs(grouped.component_total - deposit.amount) <= 0.005
        AND abs(gift.amount - deposit.amount) <= 0.005
        AND gift.archived_at IS NULL
        AND grouped.component_count = (
          SELECT count(*)::int
          FROM bank_deposit_components all_component
          WHERE all_component.bank_deposit_id = grouped.bank_deposit_id
        )
        AND grouped.component_count = (
          SELECT count(*)::int
          FROM staged_payments current_line
          WHERE current_line.realm_id = grouped.realm_id
            AND current_line.qb_deposit_id = grouped.qb_deposit_id
            AND current_line.qb_entity_type <> 'deposit_header'
            AND current_line.exclusion_reason IS NULL
            AND (current_line.funding_source IS NULL
                 OR current_line.funding_source <> 'stripe')
            AND current_line.amount IS NOT NULL
            AND current_line.amount > 0
            AND NOT EXISTS (
              SELECT 1 FROM staged_payments child
              WHERE child.split_parent_id = current_line.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM source_links tie
              WHERE tie.qb_staged_payment_id = current_line.id
                AND tie.link_type IN ('charge_qb_tie', 'charge_fee_row')
            )
        )
    ),
    updated AS (
      UPDATE payment_units unit
      SET gift_id = eligible.gift_id,
          gift_match_method = 'system_confirmed',
          gift_confirmed_by_user_id = NULL,
          gift_confirmed_at = now(),
          gift_note = COALESCE(
            unit.gift_note,
            'Carried from an exact same-payer QBO Deposit split'
          ),
          created_the_gift = false,
          updated_at = now()
      FROM component_rows rows
      JOIN eligible
        ON eligible.bank_deposit_id = rows.bank_deposit_id
       AND eligible.realm_id = rows.realm_id
       AND eligible.qb_deposit_id = rows.qb_deposit_id
      WHERE unit.id = rows.payment_unit_id
        AND unit.gift_id IS NULL
      RETURNING unit.gift_id
    )
    SELECT DISTINCT gift_id FROM updated WHERE gift_id IS NOT NULL
  `);
  return (result.rows as Array<{ gift_id: string }>).map((row) => row.gift_id);
}

/**
 * Collapse the one safe duplicate shape produced when a direct deposit was
 * decomposed manually before its QuickBooks Deposit arrived.
 *
 * A qbo_line_deposit row is accounting evidence, not a second payment. When
 * exactly one live QBO line and exactly one existing direct component on the
 * same deposit have the same amount, attach the QBO provenance to that
 * component's payment unit and retire the deterministic QBO-only unit. The
 * merge is intentionally silent for amount ties or incompatible CRM/Donorbox
 * identities; those remain human decisions.
 *
 * This is the shared identity-consolidation boundary used by both forward
 * recompute and the human confirmation route. It also repairs previously
 * generated duplicates (including duplicate gift pointers) on the next run.
 */
export async function mergeUnambiguousQboDepositLines(
  onlySourceLinkId?: string,
): Promise<number> {
  const candidatesResult = await db.execute(sql`
    WITH candidate_pairs AS (
      SELECT
        sl.id AS source_link_id,
        sp.id AS staged_payment_id,
        sl.bank_deposit_id,
        c.id AS component_id,
        c.payment_unit_id AS target_unit_id,
        'pu_' || sp.id AS auto_unit_id,
        count(*) OVER (PARTITION BY sl.id) AS line_match_count,
        count(*) OVER (PARTITION BY c.id) AS component_match_count
      FROM source_links sl
      JOIN staged_payments sp ON sp.id = sl.qb_staged_payment_id
      JOIN bank_deposit_components c
        ON c.bank_deposit_id = sl.bank_deposit_id
       AND c.amount = sp.amount
      JOIN payment_units target_unit ON target_unit.id = c.payment_unit_id
      LEFT JOIN payment_units auto_unit ON auto_unit.id = 'pu_' || sp.id
      WHERE sl.link_type = 'qbo_line_deposit'
        AND sl.match_basis = 'deposit_header_exact'
        AND (${onlySourceLinkId ?? null}::text IS NULL OR sl.id = ${onlySourceLinkId ?? null})
        AND sp.exclusion_reason IS NULL
        AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
        AND c.exclusion_reason IS NULL
        AND c.source_staged_payment_id IS NULL
        AND NOT c.needs_review
        AND NOT c.ambiguous_deposit_match
        AND target_unit.stripe_charge_id IS NULL
        AND target_unit.id <> 'pu_' || sp.id
        AND (
          target_unit.source_staged_payment_id IS NULL
          OR target_unit.source_staged_payment_id = sp.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM bank_deposit_components auto_component
          WHERE auto_component.payment_unit_id = auto_unit.id
        )
        AND (
          auto_unit.id IS NULL
          OR target_unit.gift_id IS NULL
          OR auto_unit.gift_id IS NULL
          OR target_unit.gift_id = auto_unit.gift_id
        )
        AND (
          auto_unit.id IS NULL
          OR target_unit.donorbox_donation_id IS NULL
          OR auto_unit.donorbox_donation_id IS NULL
          OR target_unit.donorbox_donation_id = auto_unit.donorbox_donation_id
        )
    )
    SELECT source_link_id, staged_payment_id, bank_deposit_id, component_id,
           target_unit_id, auto_unit_id
    FROM candidate_pairs
    WHERE line_match_count = 1 AND component_match_count = 1
    ORDER BY source_link_id
  `);

  let merged = 0;
  const opportunityIdsToRederive = new Set<string>();
  for (const candidate of candidatesResult.rows as QboDepositLineMergeCandidate[]) {
    const outcome = await db.transaction(async (tx) => {
      // Serialize with component creation/moves on this deposit. The mutation
      // routes take the same row lock before calculating remaining capacity.
      const lockedDeposit = await tx.execute(sql`
        SELECT id
        FROM bank_deposits
        WHERE id = ${candidate.bank_deposit_id}
        FOR UPDATE
      `);
      if (!lockedDeposit.rows.length) return null;

      const lockedResult = await tx.execute(sql`
        SELECT
          sl.id AS source_link_id,
          sp.id AS staged_payment_id,
          sp.amount::text AS staged_amount,
          c.id AS component_id,
          c.amount::text AS component_amount,
          target_unit.id AS target_unit_id,
          target_unit.source_staged_payment_id AS target_source_id,
          target_unit.gift_id AS target_gift_id,
          target_unit.donorbox_donation_id AS target_donorbox_id
        FROM source_links sl
        JOIN staged_payments sp ON sp.id = sl.qb_staged_payment_id
        JOIN bank_deposit_components c
          ON c.id = ${candidate.component_id}
         AND c.bank_deposit_id = sl.bank_deposit_id
         AND c.amount = sp.amount
        JOIN payment_units target_unit ON target_unit.id = c.payment_unit_id
        WHERE sl.id = ${candidate.source_link_id}
          AND sl.link_type = 'qbo_line_deposit'
          AND sl.match_basis = 'deposit_header_exact'
          AND sl.bank_deposit_id = ${candidate.bank_deposit_id}
          AND sp.id = ${candidate.staged_payment_id}
          AND sp.exclusion_reason IS NULL
          AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
          AND c.exclusion_reason IS NULL
          AND c.source_staged_payment_id IS NULL
          AND NOT c.needs_review
          AND NOT c.ambiguous_deposit_match
          AND target_unit.stripe_charge_id IS NULL
          AND target_unit.id = ${candidate.target_unit_id}
          AND (
            target_unit.source_staged_payment_id IS NULL
            OR target_unit.source_staged_payment_id = sp.id
          )
        FOR UPDATE OF sl, sp, c, target_unit
      `);
      const locked = (
        lockedResult.rows as Array<{
          source_link_id: string;
          staged_payment_id: string;
          staged_amount: string;
          component_id: string;
          component_amount: string;
          target_unit_id: string;
          target_source_id: string | null;
          target_gift_id: string | null;
          target_donorbox_id: string | null;
        }>
      )[0];
      if (!locked) return null;

      // Recheck one-to-one cardinality under the deposit lock so a concurrent
      // human component edit cannot turn a safe merge into a guess.
      const cardinality = await tx.execute(sql`
        SELECT
          (
            SELECT count(*)::int
            FROM bank_deposit_components c
            WHERE c.bank_deposit_id = ${candidate.bank_deposit_id}
              AND c.amount = ${locked.staged_amount}::numeric
              AND c.exclusion_reason IS NULL
              AND c.payment_unit_id <> ${candidate.auto_unit_id}
          ) AS component_count,
          (
            SELECT count(*)::int
            FROM source_links sl
            JOIN staged_payments sp ON sp.id = sl.qb_staged_payment_id
            WHERE sl.link_type = 'qbo_line_deposit'
              AND sl.bank_deposit_id = ${candidate.bank_deposit_id}
              AND sp.amount = ${locked.component_amount}::numeric
              AND sp.exclusion_reason IS NULL
              AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
          ) AS line_count
      `);
      const counts = (
        cardinality.rows as Array<{
          component_count: number;
          line_count: number;
        }>
      )[0];
      if (counts?.component_count !== 1 || counts?.line_count !== 1)
        return null;

      const autoResult = await tx.execute(sql`
        SELECT id, gift_id, gift_allocation_id, gift_match_method,
               gift_confirmed_by_user_id, gift_confirmed_at, gift_note,
               created_the_gift, donorbox_donation_id
        FROM payment_units
        WHERE id = ${candidate.auto_unit_id}
        FOR UPDATE
      `);
      const autoUnit = (
        autoResult.rows as Array<{
          id: string;
          gift_id: string | null;
          gift_allocation_id: string | null;
          gift_match_method: string | null;
          gift_confirmed_by_user_id: string | null;
          gift_confirmed_at: Date | null;
          gift_note: string | null;
          created_the_gift: boolean;
          donorbox_donation_id: string | null;
        }>
      )[0];

      if (autoUnit) {
        if (
          locked.target_gift_id &&
          autoUnit.gift_id &&
          locked.target_gift_id !== autoUnit.gift_id
        ) {
          return null;
        }
        if (
          locked.target_donorbox_id &&
          autoUnit.donorbox_donation_id &&
          locked.target_donorbox_id !== autoUnit.donorbox_donation_id
        ) {
          return null;
        }
        await tx.execute(sql`
          DELETE FROM source_links auto_link
          USING source_links target_link
          WHERE auto_link.payment_unit_id = ${candidate.auto_unit_id}
            AND target_link.payment_unit_id = ${candidate.target_unit_id}
            AND auto_link.link_type = 'unit_gift_corroboration'
            AND target_link.link_type = 'unit_gift_corroboration'
            AND auto_link.gift_id = target_link.gift_id
        `);
        await tx.execute(sql`
          UPDATE source_links
          SET payment_unit_id = ${candidate.target_unit_id}, updated_at = now()
          WHERE payment_unit_id = ${candidate.auto_unit_id}
        `);

        // Release the one-to-one Donorbox key before moving it to the survivor.
        if (autoUnit.donorbox_donation_id && !locked.target_donorbox_id) {
          await tx.execute(sql`
            UPDATE payment_units
            SET donorbox_donation_id = NULL, updated_at = now()
            WHERE id = ${candidate.auto_unit_id}
          `);
        }
      }

      await tx.execute(sql`
        UPDATE payment_units
        SET source_staged_payment_id = ${candidate.staged_payment_id},
            donorbox_donation_id = COALESCE(
              donorbox_donation_id,
              ${autoUnit?.donorbox_donation_id ?? null}
            ),
            gift_id = COALESCE(gift_id, ${autoUnit?.gift_id ?? null}),
            gift_allocation_id = CASE WHEN gift_id IS NULL
              THEN ${autoUnit?.gift_allocation_id ?? null}
              ELSE gift_allocation_id END,
            gift_match_method = CASE WHEN gift_id IS NULL
              THEN ${autoUnit?.gift_match_method ?? null}::payment_application_match_method
              ELSE gift_match_method END,
            gift_confirmed_by_user_id = CASE WHEN gift_id IS NULL
              THEN ${autoUnit?.gift_confirmed_by_user_id ?? null}
              ELSE gift_confirmed_by_user_id END,
            gift_confirmed_at = CASE WHEN gift_id IS NULL
              THEN ${autoUnit?.gift_confirmed_at ?? null}
              ELSE gift_confirmed_at END,
            gift_note = CASE WHEN gift_id IS NULL
              THEN ${autoUnit?.gift_note ?? null}
              ELSE gift_note END,
            created_the_gift = CASE WHEN gift_id IS NULL
              THEN ${autoUnit?.created_the_gift ?? false}
              ELSE created_the_gift END,
            updated_at = now()
        WHERE id = ${candidate.target_unit_id}
      `);
      await tx.execute(sql`
        UPDATE bank_deposit_components
        SET source_staged_payment_id = ${candidate.staged_payment_id},
            updated_at = now()
        WHERE id = ${candidate.component_id}
      `);
      await tx.execute(sql`
        DELETE FROM source_links
        WHERE id = ${candidate.source_link_id}
          AND link_type = 'qbo_line_deposit'
      `);

      if (autoUnit) {
        const deletedAuto = await tx.execute(sql`
          DELETE FROM payment_units auto_unit
          WHERE auto_unit.id = ${candidate.auto_unit_id}
            AND NOT EXISTS (
              SELECT 1 FROM bank_deposit_components c
              WHERE c.payment_unit_id = auto_unit.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM source_links sl
              WHERE sl.payment_unit_id = auto_unit.id
            )
          RETURNING id
        `);
        if (!deletedAuto.rows.length) {
          throw new Error(
            `Could not retire duplicate QBO payment unit ${candidate.auto_unit_id}`,
          );
        }
      }
      const effectiveGiftId =
        locked.target_gift_id ?? autoUnit?.gift_id ?? null;
      const opportunityResult = effectiveGiftId
        ? await tx.execute(sql`
            SELECT opportunity_id
            FROM gifts_and_payments
            WHERE id = ${effectiveGiftId}
          `)
        : null;
      const opportunityId = (
        opportunityResult?.rows as
          | Array<{ opportunity_id: string | null }>
          | undefined
      )?.[0]?.opportunity_id;
      return { opportunityId };
    });
    if (outcome) {
      merged += 1;
      if (outcome.opportunityId) {
        opportunityIdsToRederive.add(outcome.opportunityId);
      }
    }
  }
  if (opportunityIdsToRederive.size) {
    await applyDerivedOppFieldsMany(...opportunityIdsToRederive);
  }
  return merged;
}

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
 *   4f. QBO-grain source_links ← register↔deposit matching
 *       (docs/adr-qbo-evidence-grain.md; 0189–0191, legacy tables retired 0192)
 *   5. donorbox pointer        ← pulled charge id / human link  (0165)
 *   6. (retired) unit→gift pointer sync — payment_units.gift_id IS the
 *      counted authority now (docs/adr-unit-gift-pointer.md; 0201)
 *   7. QBO accounting sidecar  ← expected-vs-actual comparer        (0166)
 *
 * Lifecycle refresh: a charge's refund/dispute facts can change after its unit
 * exists, so step 2 also re-derives lifecycle on existing stripe units.
 */
export async function recomputeBankSpine(): Promise<void> {
  const lockSession = await pool.connect();
  try {
    await lockSession.query("SELECT pg_advisory_lock($1)", [
      BANK_SPINE_ADVISORY_LOCK_KEY,
    ]);
    await runBankSpineRecompute();
  } finally {
    try {
      await lockSession.query("SELECT pg_advisory_unlock($1)", [
        BANK_SPINE_ADVISORY_LOCK_KEY,
      ]);
    } finally {
      lockSession.release();
    }
  }
}

async function runBankSpineRecompute(): Promise<void> {
  // 1. Project positive bank evidence lines into bank_deposits (0159/0170).
  await db.execute(sql`
    INSERT INTO bank_deposits (
      id, source, source_bank_transaction_id, deposit_date, amount,
      currency, account, location, reference, memo
    )
    SELECT
      COALESCE(
        (
          SELECT d.id
          FROM bank_deposits d
          WHERE d.source_bank_transaction_id = bt.id
        ),
        'bdep_' || substring(bt.id FROM 5)
      ),
      'bank_csv_export', bt.id,
      bt.txn_date, bt.deposit, 'USD', bt.account, bt.location, bt.ref_no, bt.memo
    FROM bank_transactions bt
    WHERE bt.source = 'bank_csv_export'
      AND bt.deposit IS NOT NULL AND bt.deposit > 0
    -- The source transaction is the canonical projection identity. Resolve an
    -- already-linked legacy row's id before inserting; otherwise use the
    -- deterministic id. Conflict-on-id also reattaches a deterministic curated
    -- row whose source pointer was cleared when its raw row was removed.
    ON CONFLICT (id) DO UPDATE SET
      source = EXCLUDED.source,
      source_bank_transaction_id = EXCLUDED.source_bank_transaction_id,
      deposit_date = EXCLUDED.deposit_date,
      amount = EXCLUDED.amount,
      account = EXCLUDED.account,
      location = EXCLUDED.location,
      reference = EXCLUDED.reference,
      memo = EXCLUDED.memo,
      updated_at = now()
  `);

  // 2. One unit per non-excluded Stripe charge (0160). Take the same
  // parent-row lock mode required by the FK in one stable order before the
  // insert. KEY SHARE prevents a concurrent delete or key change without
  // unnecessarily blocking ordinary Stripe fact refreshes.
  await db.execute(sql`
    WITH eligible_stripe_charges AS MATERIALIZED (
      SELECT
        sc.id,
        sc.gross_amount,
        sc.fee_amount,
        sc.net_amount,
        sc.currency,
        sc.date_received,
        sc.disputed,
        sc.refunded,
        sc.amount_refunded
      FROM stripe_staged_charges sc
      WHERE sc.exclusion_reason IS NULL
      ORDER BY sc.id
      FOR KEY SHARE OF sc
    )
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
    FROM eligible_stripe_charges sc
    ORDER BY sc.id
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
      AND pu.gift_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM source_links sl WHERE sl.payment_unit_id = pu.id)
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

  // 4a. Deposit-grain QBO evidence is written before any QBO-backed payment
  //     unit is minted. This ordering lets a late QBO Deposit corroborate an
  //     existing manual component at the shared identity boundary first.
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
    INSERT INTO source_links (
      id, link_type, qb_staged_payment_id, bank_deposit_id,
      lifecycle, provenance, match_basis
    )
    SELECT
      'srcl_qld_' || m.id, 'qbo_line_deposit',
      m.id, p.bank_deposit_id, 'confirmed', 'system',
      CASE WHEN p.ambiguous
        THEN 'deposit_header_ambiguous'::source_link_match_basis
        ELSE 'deposit_header_exact'::source_link_match_basis
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

  // 4b. A QBO Deposit arriving after a manual decomposition is corroborating
  //     evidence for the existing unit, not permission to mint a parallel
  //     payment. Consolidate only the unique same-deposit/same-amount shape;
  //     ambiguous equal-amount rows remain untouched for human review.
  await mergeUnambiguousQboDepositLines();

  // 4c. Provisional check/direct-payment units from QBO deposit-composing rows
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
    WHERE (
      NOT EXISTS (SELECT 1 FROM payment_units x
                  WHERE x.donorbox_donation_id = u.unit_donorbox_donation_id)
      OR u.unit_donorbox_donation_id IS NULL
    )
      AND NOT EXISTS (
        SELECT 1 FROM payment_units existing_source
        WHERE existing_source.source_staged_payment_id = u.id
      )
    ON CONFLICT (id) DO NOTHING
  `);

  // QBO is a sync-owned mirror. Reconcile its current direct-line facts onto
  // already-minted QBO units/components before calculating remaining deposit
  // capacity; otherwise an edited $80k line can stay $80k while the current
  // composition correctly says $65k + $15k.
  await refreshQboDerivedDirectPaymentFacts();

  // 4d. Deposit components where the QBO Deposit pairs to a register deposit
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
    ),
    candidates AS (
      SELECT s.id, pr.bank_deposit_id, s.amount, pr.ambiguous, s.funding_source,
        sum(s.amount) OVER (PARTITION BY pr.bank_deposit_id ORDER BY s.id) AS running_total,
        (SELECT d.amount FROM bank_deposits d WHERE d.id = pr.bank_deposit_id) AS deposit_amount,
        (SELECT COALESCE(sum(c.amount), 0) FROM bank_deposit_components c
          WHERE c.bank_deposit_id = pr.bank_deposit_id) AS existing_total
      FROM scope s
      JOIN pairs pr
        ON pr.realm_id = s.realm_id AND pr.qb_deposit_id = s.qb_deposit_id
    )
    INSERT INTO bank_deposit_components (
      id, bank_deposit_id, payment_unit_id, amount, source,
      source_staged_payment_id, ambiguous_deposit_match, needs_review
    )
    SELECT
      'bdc_' || c.id, c.bank_deposit_id, 'pu_' || c.id, c.amount,
      'qbo_inferred', c.id, c.ambiguous,
      COALESCE(c.funding_source = 'paypal', false)
    FROM candidates c
    WHERE c.existing_total + c.running_total <= c.deposit_amount + 0.005
    ON CONFLICT (id) DO NOTHING
  `);

  const splitGiftIds = await carryGiftAcrossUnambiguousQboDepositSplit();
  if (splitGiftIds.length) {
    const opportunities = await db.execute(sql`
      SELECT DISTINCT opportunity_id
      FROM gifts_and_payments
      WHERE id IN (${sql.join(
        splitGiftIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        AND opportunity_id IS NOT NULL
    `);
    const opportunityIds = (
      opportunities.rows as Array<{ opportunity_id: string }>
    ).map((row) => row.opportunity_id);
    if (opportunityIds.length) {
      await applyDerivedOppFieldsMany(...opportunityIds);
    }
  }

  // 4e. Once a newly minted QBO unit becomes a real bank component, its
  //     deposit-line sidecar is redundant. QBO provenance now lives on the
  //     unit/component and renders in Accounting from there.
  await db.execute(sql`
    DELETE FROM source_links qbo_line
    USING bank_deposit_components component
    WHERE qbo_line.link_type = 'qbo_line_deposit'
      AND component.bank_deposit_id = qbo_line.bank_deposit_id
      AND component.source_staged_payment_id = qbo_line.qb_staged_payment_id
  `);

  // 4f. QBO-grain source_links (docs/adr-qbo-evidence-grain.md) — THE tie
  //     mechanism for all QBO evidence (the legacy tables are retired).
  //     Everything here uses deterministic ids. Source-owned QBO facts refresh
  //     in place; review-owned facts remain fill-only. The
  //     payout_qb_settlement pairing is written where it is decided
  //     (qboAccountingRecompute + the reconciliation commit flows).

  // 4f-ii. Broadened register↔deposit matching, WITHOUT the legacy residual
  //        gating: register accounting evidence coexists with payouts,
  //        components, and provisional decomposition (the tie is downstream
  //        accounting documentation, never money composition). Single-row:
  //        unique exact amount within ±3 days, unique on both sides.
  await db.execute(sql`
    WITH scope AS (
      SELECT d.id, d.amount, d.deposit_date
      FROM bank_deposits d
      WHERE d.source = 'bank_csv_export'
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'qbo_register_deposit'
            AND sl.bank_deposit_id = d.id
        )
    ),
    candidate_pairs AS (
      SELECT d.id AS bank_deposit_id, bt.id AS bank_transaction_id,
        abs(bt.txn_date - d.deposit_date) AS day_gap
      FROM scope d
      JOIN bank_transactions bt
        ON bt.source = 'qbo_register_export'
       AND bt.deposit IS NOT NULL AND bt.deposit > 0
       AND bt.deposit = d.amount
       AND bt.txn_date BETWEEN d.deposit_date - 3 AND d.deposit_date + 3
      WHERE NOT EXISTS (
        SELECT 1 FROM source_links sl
        WHERE sl.link_type = 'qbo_register_deposit'
          AND sl.bank_transaction_id = bt.id
      )
    ),
    unique_pairs AS (
      SELECT p.bank_deposit_id, p.bank_transaction_id, p.day_gap
      FROM candidate_pairs p
      WHERE (SELECT count(*) FROM candidate_pairs dc
             WHERE dc.bank_deposit_id = p.bank_deposit_id) = 1
        AND (SELECT count(*) FROM candidate_pairs rc
             WHERE rc.bank_transaction_id = p.bank_transaction_id) = 1
    )
    INSERT INTO source_links (
      id, link_type, bank_transaction_id, bank_deposit_id,
      lifecycle, provenance, match_basis
    )
    SELECT
      'srcl_qrd_' || p.bank_transaction_id, 'qbo_register_deposit',
      p.bank_transaction_id, p.bank_deposit_id, 'confirmed', 'system',
      CASE p.day_gap
        WHEN 0 THEN 'same_day_unique_amount'
        WHEN 1 THEN 'one_day_unique_amount'
        WHEN 2 THEN 'two_day_unique_amount'
        ELSE 'three_day_unique_amount'
      END::source_link_match_basis
    FROM unique_pairs p
    ON CONFLICT (id) DO NOTHING
  `);

  // 4f-ii-b. Equal-count same-day matching: N identical-amount register rows
  //          on one date and exactly N same-amount open deposits on the same
  //          date are interchangeable, so they pair one-to-one — the strict
  //          both-sides-unique rule above can never match them (e.g. two
  //          $479.20 Stripe transfers landing the same day). Guarded so no
  //          other open candidate of that amount exists in the ±3-day window.
  await db.execute(sql`
    WITH open_deposits AS (
      SELECT d.id, d.amount, d.deposit_date
      FROM bank_deposits d
      WHERE d.source = 'bank_csv_export'
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'qbo_register_deposit'
            AND sl.bank_deposit_id = d.id
        )
    ),
    open_reg AS (
      SELECT bt.id, bt.deposit AS amount, bt.txn_date
      FROM bank_transactions bt
      WHERE bt.source = 'qbo_register_export'
        AND bt.deposit IS NOT NULL AND bt.deposit > 0
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'qbo_register_deposit'
            AND sl.bank_transaction_id = bt.id
        )
    ),
    dep_groups AS (
      SELECT amount, deposit_date, array_agg(id ORDER BY id) AS ids,
        count(*) AS n
      FROM open_deposits
      GROUP BY amount, deposit_date
    ),
    reg_groups AS (
      SELECT amount, txn_date, array_agg(id ORDER BY id) AS ids,
        count(*) AS n
      FROM open_reg
      GROUP BY amount, txn_date
    ),
    eligible AS (
      SELECT d.amount, d.deposit_date, d.ids AS dep_ids, r.ids AS reg_ids, d.n
      FROM dep_groups d
      JOIN reg_groups r
        ON r.amount = d.amount AND r.txn_date = d.deposit_date AND r.n = d.n
      WHERE d.n >= 2
        AND NOT EXISTS (
          SELECT 1 FROM open_reg o
          WHERE o.amount = d.amount AND o.txn_date <> d.deposit_date
            AND o.txn_date BETWEEN d.deposit_date - 3 AND d.deposit_date + 3
        )
        AND NOT EXISTS (
          SELECT 1 FROM open_deposits o
          WHERE o.amount = d.amount AND o.deposit_date <> d.deposit_date
            AND o.deposit_date BETWEEN d.deposit_date - 3 AND d.deposit_date + 3
        )
    )
    INSERT INTO source_links (
      id, link_type, bank_transaction_id, bank_deposit_id,
      lifecycle, provenance, match_basis
    )
    SELECT
      'srcl_qrd_' || e.reg_ids[i], 'qbo_register_deposit',
      e.reg_ids[i], e.dep_ids[i], 'confirmed', 'system',
      'same_day_equal_count_amount'
    FROM eligible e, generate_series(1, e.n) AS i
    ON CONFLICT (id) DO NOTHING
  `);

  // 4f-iii. Same-day/same-donor multi-row sums: when ≥2 positive register
  //         rows share a date + normalized payee and their SUM uniquely
  //         equals a still-unlinked deposit within ±3 days, each row ties to
  //         that deposit (presumed one physical payment posted as
  //         gift-allocation-level register entries).
  await db.execute(sql`
    WITH open_deposits AS (
      SELECT d.id, d.amount, d.deposit_date
      FROM bank_deposits d
      WHERE d.source = 'bank_csv_export'
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'qbo_register_deposit'
            AND sl.bank_deposit_id = d.id
        )
    ),
    reg AS (
      SELECT bt.id, bt.deposit AS amount, bt.txn_date,
        lower(regexp_replace(trim(bt.payee), '\\s+', ' ', 'g')) AS payee_norm
      FROM bank_transactions bt
      WHERE bt.source = 'qbo_register_export'
        AND bt.deposit IS NOT NULL AND bt.deposit > 0
        AND bt.payee IS NOT NULL AND trim(bt.payee) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'qbo_register_deposit'
            AND sl.bank_transaction_id = bt.id
        )
    ),
    clusters AS (
      SELECT txn_date, payee_norm, sum(amount) AS cluster_sum
      FROM reg
      GROUP BY txn_date, payee_norm
      HAVING count(*) >= 2
    ),
    candidate_matches AS (
      SELECT c.txn_date, c.payee_norm, d.id AS bank_deposit_id
      FROM clusters c
      JOIN open_deposits d
        ON d.amount = c.cluster_sum
       AND c.txn_date BETWEEN d.deposit_date - 3 AND d.deposit_date + 3
    ),
    unique_matches AS (
      SELECT m.txn_date, m.payee_norm, m.bank_deposit_id
      FROM candidate_matches m
      WHERE (SELECT count(*) FROM candidate_matches dm
             WHERE dm.bank_deposit_id = m.bank_deposit_id) = 1
        AND (SELECT count(*) FROM candidate_matches cm
             WHERE cm.txn_date = m.txn_date AND cm.payee_norm = m.payee_norm) = 1
    )
    INSERT INTO source_links (
      id, link_type, bank_transaction_id, bank_deposit_id,
      lifecycle, provenance, match_basis
    )
    SELECT
      'srcl_qrd_' || r.id, 'qbo_register_deposit',
      r.id, m.bank_deposit_id, 'confirmed', 'system',
      'same_donor_multi_row_sum'
    FROM unique_matches m
    JOIN reg r ON r.txn_date = m.txn_date AND r.payee_norm = m.payee_norm
    ON CONFLICT (id) DO NOTHING
  `);

  // 4f-iv. Unit-grain register claims where the deposit's composition makes
  //        the row↔unit correspondence exact: a register row tied to a
  //        deposit whose components include exactly one payment unit of the
  //        SAME amount. Dollars count once — the unit link is the finer
  //        grain; the deposit link above becomes corroboration.
  await db.execute(sql`
    WITH deposit_links AS (
      SELECT sl.bank_transaction_id, sl.bank_deposit_id, bt.deposit AS amount
      FROM source_links sl
      JOIN bank_transactions bt ON bt.id = sl.bank_transaction_id
      WHERE sl.link_type = 'qbo_register_deposit'
    ),
    unit_candidates AS (
      SELECT dl.bank_transaction_id, c.payment_unit_id,
        count(*) OVER (PARTITION BY dl.bank_transaction_id) AS n_units
      FROM deposit_links dl
      JOIN bank_deposit_components c
        ON c.bank_deposit_id = dl.bank_deposit_id
       AND c.amount = dl.amount
      WHERE c.payment_unit_id IS NOT NULL
    )
    INSERT INTO source_links (
      id, link_type, bank_transaction_id, payment_unit_id,
      lifecycle, provenance, note
    )
    SELECT
      'srcl_qru_' || u.bank_transaction_id, 'qbo_register_unit',
      u.bank_transaction_id, u.payment_unit_id, 'confirmed', 'system',
      'unique same-amount component unit within the linked deposit'
    FROM unit_candidates u
    WHERE u.n_units = 1
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

  // 6. (retired) Unit→gift pointer sync: payment_units.gift_id + the tie
  //    fact columns are the write authority (docs/adr-unit-gift-pointer.md);
  //    the payment_applications ledger is no longer written or read here.

  // 7. QBO expected-vs-actual sidecar (0166's comparer).
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
