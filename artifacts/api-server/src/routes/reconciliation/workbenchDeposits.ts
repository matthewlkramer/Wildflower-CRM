import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  bankDepositComponents,
  bankDepositExclusions,
  bankDeposits,
} from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { requireFinance, viewerCanManageAccounting } from "../../lib/financeGuard";
import { getViewer, maskName } from "../../lib/identityVisibility";
import {
  ClearBankDepositExclusionParams,
  ExcludeBankDepositComponentBody,
  ExcludeBankDepositComponentParams,
  ReIncludeBankDepositComponentParams,
  SetBankDepositExclusionBody,
  SetBankDepositExclusionParams,
} from "@workspace/api-zod";
import {
  informationStateOf,
  lensFlagsFromState,
  rowCompleteFromState,
  type WorkbenchRowState,
  type CrmCardState,
  type TransactionCardState,
} from "./workbenchRowState";
import { buildCrmRecordCompleteness } from "./workbenchClusters";

const router: IRouter = Router();

const LENSES = [
  "all_open",
  "unresolved_composition",
  "ambiguous_pairing",
  "needs_gift",
  "accounting_corrections",
  "refunds",
  "completed",
  "not_fundraising",
] as const;
type Lens = (typeof LENSES)[number];

const LENS_PREDICATE: Record<Lens, string> = {
  all_open:
    "(NOT f_not_fundraising AND (f_unresolved OR f_ambiguous OR f_needs_gift OR f_correction) AND NOT f_completed)",
  unresolved_composition: "f_unresolved",
  ambiguous_pairing: "f_ambiguous",
  needs_gift: "f_needs_gift",
  accounting_corrections: "f_correction",
  refunds: "f_refund",
  completed: "f_completed",
  not_fundraising: "f_not_fundraising",
};

type SlimRow = {
  id: string;
  anchor_date: string;
  f_unresolved: boolean;
  f_ambiguous: boolean;
  f_needs_gift: boolean;
  f_correction: boolean;
  f_refund: boolean;
  f_completed: boolean;
  f_not_fundraising: boolean;
};

type DepositRow = {
  id: string;
  deposit_date: string;
  amount: string;
  currency: string;
  account: string | null;
  location: string | null;
  reference: string | null;
  memo: string | null;
  payee: string | null;
  ref_no: string | null;
  txn_type: string | null;
  payout_id: string | null;
  payout_ambiguous: boolean;
  payout_refund: boolean;
  payout_net: string | null;
  payout_date: string | null;
  payout_gross: string | null;
  payout_fee: string | null;
  payout_refund_total: string | null;
  payout_adjustment: string | null;
  payout_charge_count: number | null;
  bank_exclusion_reason: string | null;
  bank_exclusion_note: string | null;
  not_fundraising_reason: string | null;
  components: Array<{
    componentId: string;
    paymentUnitId: string | null;
    amount: string;
    kind: string;
    needsReview: boolean;
    ambiguousDepositMatch: boolean;
    countedGiftIds: string[];
    unconfirmed?: boolean;
    source?: "bank_spine" | "qbo_provisional";
    stagedPaymentId?: string | null;
    label?: string | null;
    exclusionReason?: string | null;
    matchBasis?: "deposit_header_exact" | "deposit_header_ambiguous" | null;
  }>;
  provisional_components: DepositRow["components"];
  units: Array<{
    paymentUnitId: string;
    kind: string;
    amount: string | null;
    lifecycle: string;
    sourceStagedPaymentId: string | null;
    countedGiftIds: string[];
  }>;
  gifts: Array<{
    giftId: string;
    opportunityId: string | null;
    name: string | null;
    donorName: string | null;
    donorKind: "organization" | "person" | "household" | null;
    donorId: string | null;
    donorAnonymous: boolean;
    donorOwnerUserId: string | null;
    amount: string | null;
    dateReceived: string | null;
    donorbox: boolean;
    grantLetter: boolean;
    codingForm: boolean;
    recordComplete: boolean;
    linkedChargeIds: string[];
    linkedStagedPaymentIds: string[];
  }>;
  charges: Array<Record<string, unknown>>;
  qb_records: Array<Record<string, unknown>>;
  accounting_checks: Array<Record<string, unknown>>;
};

function amount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function inferredPaymentMethod(alias: "sp" | "psp" | "qsp") {
  return sql.raw(`CASE
    WHEN NULLIF(BTRIM(${alias}.qb_payment_method), '') IS NOT NULL THEN ${alias}.qb_payment_method
    WHEN COALESCE(${alias}.qb_transaction_memo, '') ~* '(^|[^A-Z])(WT|FED#|WIRE)([^A-Z]|$)'
      OR COALESCE(d.memo, '') ~* '(^|[^A-Z])(WT|FED#|WIRE)([^A-Z]|$)' THEN 'wire'
    WHEN COALESCE(${alias}.qb_transaction_memo, '') ~* '(GVD|EDI|ONLINE[[:space:]]+PAYMENT|ACH|EFT)'
      OR COALESCE(d.memo, '') ~* '(GVD|EDI|ONLINE[[:space:]]+PAYMENT|ACH|EFT)' THEN 'ach'
    WHEN ${alias}.qb_check_number IS NOT NULL
      OR COALESCE(${alias}.qb_transaction_memo, '') ~* '(LBX|LOCKBOX|CHECK)'
      OR COALESCE(d.memo, '') ~* '(LBX|LOCKBOX|CHECK)' THEN 'check'
    ELSE 'other'
  END`);
}

function notFundraisingMemo(memo: string | null): boolean {
  if (!memo) return false;
  // Brokerage transfers are intentionally excluded from this classification:
  // stock-donation proceeds can carry a "TRANSFER FROM BRK" memo.
  if (/transfer\s+from\s+(brk|brokerage)/i.test(memo)) return false;
  return /\b(loan|interest|interest\s+credit|loan\s+fund)\b/i.test(memo);
}

function stateForDeposit(
  row: SlimRow,
  units: DepositRow["units"],
  gifts: DepositRow["gifts"],
  checks: DepositRow["accounting_checks"],
  qbRecords: DepositRow["qb_records"],
): WorkbenchRowState {
  const hasPayout = Boolean((row as SlimRow & { payout_id?: string | null }).payout_id);
  const hasUnits = units.length > 0;
  const countedUnits = new Set(units.filter((u) => u.countedGiftIds.length > 0).map((u) => u.paymentUnitId));
  const allUnitsBooked = hasUnits && countedUnits.size === units.length;
  const crmCompleteness = buildCrmRecordCompleteness(
    gifts.map((g) => ({
      giftId: g.giftId,
      opportunityId: g.opportunityId,
      name: g.name,
      donorName: g.donorName,
      donorKind: g.donorKind,
      donorId: g.donorId,
      amount: g.amount,
      dateReceived: g.dateReceived,
      quickbooksTie: null,
      donorbox: g.donorbox,
      grantLetter: g.grantLetter,
      codingForm: g.codingForm,
      recordComplete: g.recordComplete,
      satisfiedBy: g.recordComplete ? "donor_and_allocations" : null,
      crmReason: g.recordComplete ? null : "missing_donor",
      linkedChargeIds: g.linkedChargeIds,
      linkedStagedPaymentIds: g.linkedStagedPaymentIds,
    })),
  );
  const crmComplete = crmCompleteness.complete;
  const correction = checks.some((c) => c.disposition === "correction_needed");
  const complete = row.f_completed;
  const transactions: WorkbenchRowState["transactions"] = units.map((u) => ({
    transactionId: u.paymentUnitId,
    livePayment: u.lifecycle !== "refunded" && u.lifecycle !== "disputed",
    refundStatus: u.lifecycle === "refunded" || u.lifecycle === "partially_refunded" ? "anticipated" : "none",
    state: (u.countedGiftIds.length > 0 ? "matched" : "unmatched") as TransactionCardState,
  }));
  const crmCards: WorkbenchRowState["crmCards"] = gifts.map((g) => ({
    giftId: g.giftId,
    recordComplete: g.recordComplete,
    state: (g.linkedStagedPaymentIds.length || g.linkedChargeIds.length
      ? g.recordComplete ? "matched_complete" : "matched_incomplete"
      : g.recordComplete ? "unmatched_complete" : "unmatched_incomplete") as CrmCardState,
    satisfiedBy: g.recordComplete ? "donor_allocations_and_supporting_documents" : null,
  }));
  const state: WorkbenchRowState = {
    linkage: {
      state: complete || allUnitsBooked ? "complete" : hasUnits ? "partial" : "missing",
      accountingToTransaction: {
        state: hasPayout || checks.length > 0 || qbRecords.length > 0 ? "complete" : hasUnits ? "partial" : "missing",
        grain: hasPayout ? "bundle" : hasUnits ? "unit" : "none",
        relationshipCount: hasPayout ? 1 : checks.length,
      },
      transactionToCrm: {
        state: allUnitsBooked ? "complete" : hasUnits && countedUnits.size > 0 ? "partial" : "missing",
        grain: hasUnits ? "unit" : "none",
        relationshipCount: countedUnits.size,
      },
      accountingToCrm: {
        state: allUnitsBooked && crmComplete ? "complete" : hasUnits ? "partial" : "missing",
        grain: hasUnits ? "unit" : "none",
        relationshipCount: gifts.length,
      },
    },
    information: {
      state: informationStateOf({
        crmComplete,
        qbEvidenceComplete: hasPayout || checks.length > 0 || qbRecords.length > 0 || hasUnits,
        qbDocumented: complete,
        attentionRequired: correction,
      }),
      crmComplete,
      qbComplete: complete,
      qbEvidenceComplete: hasPayout || checks.length > 0 || qbRecords.length > 0 || hasUnits,
    },
    flags: {
      excluded: row.f_not_fundraising,
      conflict: row.f_ambiguous,
      attentionRequired: correction || row.f_refund,
    },
    settlementLinkState: hasPayout ? "confirmed" : undefined,
    qbCards: checks.map((c) => ({
      qbRecordId: String(c.stagedPaymentId),
      state: c.disposition === "consistent" || c.disposition === "corrected"
        ? "matched_complete"
        : c.disposition === "accepted_historical" ? "excluded" : "matched_conflict",
      isTransactionEvidence: false,
    })),
    transactions,
    crmCards,
  };
  return state;
}

function depositLenses(
  row: SlimRow,
  state: WorkbenchRowState,
  flags: Pick<SlimRow, "f_unresolved" | "f_ambiguous" | "f_needs_gift" | "f_correction" | "f_refund" | "f_completed" | "f_not_fundraising">,
): Lens[] {
  const out: Lens[] = [];
  const canonical = lensFlagsFromState(state);
  if (!canonical.completed && !flags.f_not_fundraising && (flags.f_unresolved || flags.f_ambiguous || flags.f_needs_gift || flags.f_correction)) out.push("all_open");
  if (flags.f_unresolved) out.push("unresolved_composition");
  if (flags.f_ambiguous) out.push("ambiguous_pairing");
  if (flags.f_needs_gift) out.push("needs_gift");
  if (flags.f_correction) out.push("accounting_corrections");
  if (canonical.refunds || flags.f_refund) out.push("refunds");
  if (canonical.completed || flags.f_completed) out.push("completed");
  if (flags.f_not_fundraising) out.push("not_fundraising");
  return out;
}

function buildUniverse(q: string | null) {
  const search = q ? `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
  return sql`
    SELECT id, anchor_date,
      (f_unresolved AND NOT f_not_fundraising) AS f_unresolved,
      (f_ambiguous AND NOT f_not_fundraising) AS f_ambiguous,
      (f_needs_gift AND NOT f_not_fundraising) AS f_needs_gift,
      (f_correction AND NOT f_not_fundraising) AS f_correction,
      f_refund,
      f_completed,
      f_not_fundraising
    FROM (
      SELECT
        d.id,
        d.deposit_date AS anchor_date,
        (
          p.id IS NULL AND (
            count(c.id) = 0 OR abs(COALESCE(sum(c.amount), 0) - d.amount) >= 0.005
          )
        ) AS f_unresolved,
        (
          COALESCE(p.ambiguous_bank_match, false) OR
          COALESCE(bool_or(c.needs_review OR c.ambiguous_deposit_match), false)
        ) AS f_ambiguous,
      (
        EXISTS (
          SELECT 1 FROM stripe_staged_charges pc
          WHERE pc.stripe_payout_id = p.id
            AND pc.raw_charge->>'status' = 'succeeded'
            AND pc.exclusion_reason IS NULL
            AND NOT (
              pc.refunded = true
              AND COALESCE(pc.amount_refunded, 0) >= pc.gross_amount
            )
            AND NOT EXISTS (
              SELECT 1 FROM payment_applications ppa
              JOIN payment_units ppu ON ppu.id = ppa.payment_unit_id
              WHERE ppu.stripe_charge_id = pc.id
                AND ppa.link_role = 'counted'
                AND ppa.lifecycle = 'confirmed'
            )
        )
        OR COALESCE(bool_or(c.id IS NOT NULL AND c.exclusion_reason IS NULL AND NOT EXISTS (
        SELECT 1 FROM payment_applications pa
        WHERE pa.payment_unit_id = c.payment_unit_id
          AND pa.link_role = 'counted'
          AND pa.lifecycle = 'confirmed'
      )), false)
      ) AS f_needs_gift,
      EXISTS (
        SELECT 1
        FROM qbo_accounting_checks qc
        JOIN payment_units qu ON qu.source_staged_payment_id = qc.staged_payment_id
        JOIN bank_deposit_components qbc ON qbc.payment_unit_id = qu.id
        WHERE qbc.bank_deposit_id = d.id AND qc.disposition = 'correction_needed'
      ) OR EXISTS (
        SELECT 1
        FROM qbo_accounting_checks pqc
        JOIN staged_payments psp ON psp.id = pqc.staged_payment_id
        JOIN stripe_payouts psp_payout ON psp_payout.id = psp.settled_stripe_payout_id
        WHERE psp_payout.bank_deposit_id = d.id
          AND pqc.disposition = 'correction_needed'
      ) AS f_correction,
      EXISTS (
        SELECT 1 FROM stripe_payouts rp
        JOIN stripe_staged_charges rc ON rc.stripe_payout_id = rp.id
        WHERE rp.bank_deposit_id = d.id
          AND rc.raw_charge->>'status' = 'succeeded'
          AND rc.refund_propagation_status = 'proposed'
      ) AS f_refund,
      (
        p.id IS NOT NULL AND NOT COALESCE(p.ambiguous_bank_match, false)
      ) OR (
        count(c.id) > 0
        AND abs(COALESCE(sum(c.amount), 0) - d.amount) < 0.005
        AND NOT COALESCE(bool_or(c.needs_review OR c.ambiguous_deposit_match), false)
        AND NOT COALESCE(bool_or(NOT EXISTS (
          SELECT 1 FROM payment_applications pa
          WHERE pa.payment_unit_id = c.payment_unit_id
            AND pa.link_role = 'counted'
            AND pa.lifecycle = 'confirmed'
        )), false)
        AND NOT EXISTS (
          SELECT 1
          FROM qbo_accounting_checks qc
          JOIN payment_units qu ON qu.source_staged_payment_id = qc.staged_payment_id
          JOIN bank_deposit_components qbc ON qbc.payment_unit_id = qu.id
          WHERE qbc.bank_deposit_id = d.id AND qc.disposition = 'correction_needed'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM qbo_accounting_checks pqc
          JOIN staged_payments psp ON psp.id = pqc.staged_payment_id
          JOIN stripe_payouts psp_payout ON psp_payout.id = psp.settled_stripe_payout_id
          WHERE psp_payout.bank_deposit_id = d.id AND pqc.disposition = 'correction_needed'
        )
      ) AS f_completed,
      (
        EXISTS (
          SELECT 1 FROM bank_deposit_exclusions bde WHERE bde.bank_deposit_id = d.id
        )
        OR (
          EXISTS (
            SELECT c_all.id
            FROM bank_deposit_components c_all
            WHERE c_all.bank_deposit_id = d.id
            UNION ALL
            SELECT dqc_all.id
            FROM deposit_qbo_components dqc_all
            WHERE dqc_all.bank_deposit_id = d.id
            UNION ALL
            SELECT ch_all.id
            FROM stripe_payouts p_all
            JOIN stripe_staged_charges ch_all ON ch_all.stripe_payout_id = p_all.id
            WHERE p_all.bank_deposit_id = d.id
          )
          AND NOT EXISTS (
            SELECT c_open.id
            FROM bank_deposit_components c_open
            WHERE c_open.bank_deposit_id = d.id
              AND c_open.exclusion_reason IS NULL
            UNION ALL
            SELECT dqc_open.id
            FROM deposit_qbo_components dqc_open
            JOIN staged_payments sp_open ON sp_open.id = dqc_open.staged_payment_id
            WHERE dqc_open.bank_deposit_id = d.id
              AND sp_open.exclusion_reason IS NULL
            UNION ALL
            SELECT ch_open.id
            FROM stripe_payouts p_open
            JOIN stripe_staged_charges ch_open ON ch_open.stripe_payout_id = p_open.id
            WHERE p_open.bank_deposit_id = d.id
              AND ch_open.exclusion_reason IS NULL
          )
        )
        OR (
        (
          COALESCE(d.memo, '') ~* '\\m(loan|interest)\\M'
          OR (
            EXISTS (
              SELECT 1
              FROM (
                SELECT qsp.id, qsp.exclusion_reason
                FROM deposit_qbo_components dqc
                JOIN staged_payments qsp ON qsp.id = dqc.staged_payment_id
                WHERE dqc.bank_deposit_id = d.id
                  AND (
                    qsp.funding_source IS NULL
                    OR qsp.funding_source <> 'stripe'
                    OR NOT EXISTS (
                      SELECT 1 FROM stripe_payouts nfp
                      WHERE nfp.bank_deposit_id = d.id
                    )
                  )
                UNION
                SELECT rsp.id, rsp.exclusion_reason
                FROM bank_deposit_components rbc
                JOIN payment_units rpu ON rpu.id = rbc.payment_unit_id
                JOIN staged_payments rsp ON rsp.id = rpu.source_staged_payment_id
                WHERE rbc.bank_deposit_id = d.id
                  AND (rsp.funding_source IS NULL OR rsp.funding_source <> 'stripe')
              ) qbo_lines
            )
            AND NOT EXISTS (
              SELECT 1
              FROM (
                SELECT qsp.id, qsp.exclusion_reason
                FROM deposit_qbo_components dqc
                JOIN staged_payments qsp ON qsp.id = dqc.staged_payment_id
                WHERE dqc.bank_deposit_id = d.id
                  AND (
                    qsp.funding_source IS NULL
                    OR qsp.funding_source <> 'stripe'
                    OR NOT EXISTS (
                      SELECT 1 FROM stripe_payouts nfp
                      WHERE nfp.bank_deposit_id = d.id
                    )
                  )
                UNION
                SELECT rsp.id, rsp.exclusion_reason
                FROM bank_deposit_components rbc
                JOIN payment_units rpu ON rpu.id = rbc.payment_unit_id
                JOIN staged_payments rsp ON rsp.id = rpu.source_staged_payment_id
                WHERE rbc.bank_deposit_id = d.id
                  AND (rsp.funding_source IS NULL OR rsp.funding_source <> 'stripe')
              ) qbo_lines
              WHERE qbo_lines.exclusion_reason IS NULL
            )
          )
        )
        AND COALESCE(d.memo, '') !~* 'transfer[[:space:]]+from[[:space:]]+(brk|brokerage)'
        )
      ) AS f_not_fundraising
    FROM bank_deposits d
    LEFT JOIN stripe_payouts p ON p.bank_deposit_id = d.id
    LEFT JOIN bank_deposit_components c ON c.bank_deposit_id = d.id
    WHERE d.source = 'bank_csv_export'
      AND (
        ${search === null ? sql`TRUE` : sql`(
          d.id ILIKE ${search} OR d.memo ILIKE ${search} OR d.reference ILIKE ${search}
          OR EXISTS (
            SELECT 1 FROM bank_deposit_components sqc
            JOIN payment_units squ ON squ.id = sqc.payment_unit_id
            LEFT JOIN payment_applications sqpa ON sqpa.payment_unit_id = squ.id AND sqpa.link_role = 'counted' AND sqpa.lifecycle = 'confirmed'
            LEFT JOIN gifts_and_payments sqg ON sqg.id = sqpa.gift_id
            WHERE sqc.bank_deposit_id = d.id
              AND (squ.id ILIKE ${search} OR sqg.name ILIKE ${search})
          )
        )`}
      )
      GROUP BY d.id, p.id, p.ambiguous_bank_match
    ) base
  `;
}

router.get(
  "/reconciliation/workbench-deposits",
  asyncHandler(async (req, res) => {
    const viewer = getViewer(req);
    const rawLens = typeof req.query.lens === "string" ? req.query.lens : "";
    const lens: Lens = (LENSES as readonly string[]).includes(rawLens) ? rawLens as Lens : "all_open";
    const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const q = rawQ.length >= 2 ? rawQ : null;
    const { limit, offset, page } = parsePagination({
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
    });
    const universe = buildUniverse(q);
    const [countsResult, pageResult] = await Promise.all([
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE ${sql.raw(LENS_PREDICATE.all_open)})::int AS all_open,
          count(*) FILTER (WHERE f_unresolved)::int AS unresolved_composition,
          count(*) FILTER (WHERE f_ambiguous)::int AS ambiguous_pairing,
          count(*) FILTER (WHERE f_needs_gift)::int AS needs_gift,
          count(*) FILTER (WHERE f_correction)::int AS accounting_corrections,
          count(*) FILTER (WHERE f_refund)::int AS refunds,
          count(*) FILTER (WHERE f_completed)::int AS completed,
          count(*) FILTER (WHERE f_not_fundraising)::int AS not_fundraising
        FROM (${universe}) u
      `),
      db.execute(sql`
        SELECT * FROM (${universe}) u
        WHERE ${sql.raw(LENS_PREDICATE[lens])}
        ORDER BY anchor_date DESC NULLS LAST, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
    ]);
    const counts = (countsResult.rows[0] ?? {}) as Record<string, number>;
    const slim = pageResult.rows as unknown as SlimRow[];
    if (slim.length === 0) {
      return res.json({
        data: [],
        lensCounts: {
          all_open: counts.all_open ?? 0,
          unresolved_composition: counts.unresolved_composition ?? 0,
          ambiguous_pairing: counts.ambiguous_pairing ?? 0,
          needs_gift: counts.needs_gift ?? 0,
          accounting_corrections: counts.accounting_corrections ?? 0,
          refunds: counts.refunds ?? 0,
          completed: counts.completed ?? 0,
          not_fundraising: counts.not_fundraising ?? 0,
        },
        pagination: { page, limit, total: counts[lens] ?? 0 },
        viewerCanManageAccounting: viewerCanManageAccounting(req),
      });
    }
    const ids = slim.map((r) => r.id);
    const rowResult = await db.execute(sql`
      SELECT
        d.id, d.deposit_date, d.amount, d.currency, d.account, d.location, d.reference, d.memo,
        bt.payee, bt.ref_no, bt.txn_type,
        p.id AS payout_id, COALESCE(p.ambiguous_bank_match, false) AS payout_ambiguous,
        p.net_total::text AS payout_net,
        p.arrival_date::text AS payout_date,
        p.gross_total::text AS payout_gross,
        p.fee_total::text AS payout_fee,
        p.refund_total::text AS payout_refund_total,
        p.adjustment_total::text AS payout_adjustment,
        p.charge_count AS payout_charge_count,
        (SELECT bde.reason::text FROM bank_deposit_exclusions bde WHERE bde.bank_deposit_id = d.id) AS bank_exclusion_reason,
        (SELECT bde.note FROM bank_deposit_exclusions bde WHERE bde.bank_deposit_id = d.id) AS bank_exclusion_note,
        COALESCE(
          (SELECT bde.reason::text FROM bank_deposit_exclusions bde WHERE bde.bank_deposit_id = d.id),
        (
          SELECT qbo_lines.exclusion_reason::text
          FROM (
            SELECT qsp.exclusion_reason
            FROM deposit_qbo_components dqc
            JOIN staged_payments qsp ON qsp.id = dqc.staged_payment_id
            WHERE dqc.bank_deposit_id = d.id
              AND (qsp.funding_source IS NULL OR qsp.funding_source <> 'stripe')
            UNION ALL
            SELECT rsp.exclusion_reason
            FROM bank_deposit_components rbc
            JOIN payment_units rpu ON rpu.id = rbc.payment_unit_id
            JOIN staged_payments rsp ON rsp.id = rpu.source_staged_payment_id
            WHERE rbc.bank_deposit_id = d.id
              AND (rsp.funding_source IS NULL OR rsp.funding_source <> 'stripe')
            UNION ALL
            SELECT rbc.exclusion_reason
            FROM bank_deposit_components rbc
            WHERE rbc.bank_deposit_id = d.id
              AND rbc.exclusion_reason IS NOT NULL
            UNION ALL
            SELECT ch.exclusion_reason
            FROM stripe_payouts rp
            JOIN stripe_staged_charges ch ON ch.stripe_payout_id = rp.id
            WHERE rp.bank_deposit_id = d.id
              AND ch.exclusion_reason IS NOT NULL
          ) qbo_lines
          WHERE qbo_lines.exclusion_reason IS NOT NULL
          GROUP BY qbo_lines.exclusion_reason
          ORDER BY count(*) DESC, qbo_lines.exclusion_reason
          LIMIT 1
        )) AS not_fundraising_reason,
        COALESCE((
          SELECT bool_or(ch.raw_charge->>'status' = 'succeeded' AND ch.refund_propagation_status = 'proposed')
          FROM stripe_staged_charges ch WHERE ch.stripe_payout_id = p.id
        ), false) AS payout_refund,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'componentId', c.id, 'paymentUnitId', u.id, 'amount', c.amount::text,
            'kind', u.kind, 'needsReview', c.needs_review,
            'ambiguousDepositMatch', c.ambiguous_deposit_match,
            'unconfirmed', false, 'source', 'bank_spine',
            'stagedPaymentId', u.source_staged_payment_id,
            'exclusionReason', c.exclusion_reason,
            'countedGiftIds', COALESCE((
              SELECT jsonb_agg(pa.gift_id) FROM payment_applications pa
              WHERE pa.payment_unit_id = u.id AND pa.link_role = 'counted' AND pa.lifecycle = 'confirmed'
            ), '[]'::jsonb)
          ) ORDER BY c.id)
          FROM bank_deposit_components c JOIN payment_units u ON u.id = c.payment_unit_id
          WHERE c.bank_deposit_id = d.id
        ), '[]'::jsonb) AS components,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'componentId', dqc.id, 'paymentUnitId', NULL,
            'amount', dqc.amount::text,
            'kind', CASE
              WHEN (${inferredPaymentMethod("sp")}) ILIKE '%check%' THEN 'check'
              WHEN (${inferredPaymentMethod("sp")}) ILIKE '%wire%' THEN 'wire'
              WHEN (${inferredPaymentMethod("sp")}) ILIKE '%ach%' OR sp.funding_source = 'wire_ach' THEN 'direct_ach'
              ELSE 'other'
            END,
            'needsReview', dqc.match_basis = 'deposit_header_ambiguous',
            'ambiguousDepositMatch', dqc.match_basis = 'deposit_header_ambiguous',
            'unconfirmed', NOT dqc.confirmed, 'source', 'qbo_provisional',
            'stagedPaymentId', sp.id,
            'label', COALESCE(sp.payer_name, sp.qb_transaction_memo, sp.line_description, sp.raw_reference, sp.id),
            'exclusionReason', sp.exclusion_reason,
            'matchBasis', dqc.match_basis,
            'countedGiftIds', '[]'::jsonb
          ) ORDER BY dqc.id)
          FROM deposit_qbo_components dqc
          JOIN staged_payments sp ON sp.id = dqc.staged_payment_id
          WHERE dqc.bank_deposit_id = d.id
        ), '[]'::jsonb) AS provisional_components,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'paymentUnitId', u.id, 'kind', u.kind, 'amount', COALESCE(u.gross_amount, u.net_amount)::text,
            'lifecycle', u.lifecycle, 'sourceStagedPaymentId', u.source_staged_payment_id,
            'countedGiftIds', COALESCE((
              SELECT jsonb_agg(pa.gift_id) FROM payment_applications pa
              WHERE pa.payment_unit_id = u.id AND pa.link_role = 'counted' AND pa.lifecycle = 'confirmed'
            ), '[]'::jsonb)
          ) ORDER BY u.id)
          FROM bank_deposit_components c JOIN payment_units u ON u.id = c.payment_unit_id
          WHERE c.bank_deposit_id = d.id
        ), '[]'::jsonb) AS units,
        COALESCE((
          SELECT jsonb_agg(DISTINCT jsonb_build_object(
            'giftId', g.id, 'opportunityId', g.opportunity_id, 'name', g.name,
            'donorName', COALESCE(o.name, h.name, p2.full_name),
            'donorKind', CASE WHEN g.organization_id IS NOT NULL THEN 'organization' WHEN g.individual_giver_person_id IS NOT NULL THEN 'person' WHEN g.household_id IS NOT NULL THEN 'household' END,
            'donorId', COALESCE(g.organization_id, g.individual_giver_person_id, g.household_id),
            'donorAnonymous', COALESCE(o.anonymous, p2.anonymous, false),
            'donorOwnerUserId', COALESCE(o.owner_user_id, p2.owner_user_id),
            'amount', g.amount::text, 'dateReceived', g.date_received::text,
            'donorbox', false, 'grantLetter', false, 'codingForm', false,
            'recordComplete', (g.organization_id IS NOT NULL OR g.individual_giver_person_id IS NOT NULL OR g.household_id IS NOT NULL)
              AND EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id),
            'linkedChargeIds', COALESCE((
              SELECT jsonb_agg(pu2.stripe_charge_id)
              FROM payment_applications pa2
              JOIN payment_units pu2 ON pu2.id = pa2.payment_unit_id
              WHERE pa2.gift_id = g.id AND pa2.link_role = 'counted' AND pa2.lifecycle = 'confirmed' AND pu2.stripe_charge_id IS NOT NULL
            ), '[]'::jsonb),
            'linkedStagedPaymentIds', COALESCE((
              SELECT jsonb_agg(pu3.source_staged_payment_id)
              FROM payment_applications pa3
              JOIN payment_units pu3 ON pu3.id = pa3.payment_unit_id
              WHERE pa3.gift_id = g.id AND pa3.link_role = 'counted' AND pa3.lifecycle = 'confirmed' AND pu3.source_staged_payment_id IS NOT NULL
            ), '[]'::jsonb)
          ))
          FROM payment_applications pa
          JOIN gifts_and_payments g ON g.id = pa.gift_id
          LEFT JOIN organizations o ON o.id = g.organization_id
          LEFT JOIN households h ON h.id = g.household_id
          LEFT JOIN people p2 ON p2.id = g.individual_giver_person_id
          WHERE pa.link_role = 'counted' AND pa.lifecycle = 'confirmed' AND (
            pa.payment_unit_id IN (SELECT c2.payment_unit_id FROM bank_deposit_components c2 WHERE c2.bank_deposit_id = d.id)
            OR pa.payment_unit_id IN (
              SELECT pu2.id
              FROM payment_units pu2
              JOIN stripe_staged_charges ch2 ON ch2.id = pu2.stripe_charge_id
              WHERE ch2.stripe_payout_id = p.id
                AND ch2.raw_charge->>'status' = 'succeeded'
            )
          )
          AND g.archived_at IS NULL
        ), '[]'::jsonb) AS gifts,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'chargeId', ch.id, 'payerName', ch.payer_name, 'cardBrand', ch.card_brand,
            'description', ch.description, 'statementDescriptor', ch.statement_descriptor,
            'amount', ch.gross_amount::text, 'feeAmount', ch.fee_amount::text,
            'netAmount', ch.net_amount::text, 'chargeDate', ch.date_received::text,
            'linkedGiftId', (SELECT pa.gift_id FROM payment_applications pa
              JOIN payment_units pu ON pu.id = pa.payment_unit_id
              WHERE pu.stripe_charge_id = ch.id AND pa.link_role = 'counted'
                AND pa.lifecycle = 'confirmed' LIMIT 1),
            'refunded', ch.refunded, 'amountRefunded', ch.amount_refunded::text,
            'refundPropagationStatus', ch.refund_propagation_status,
            'refundPropagationKind', ch.refund_propagation_kind,
            'refundProposedAmount', ch.refund_proposed_amount::text,
            'refundKind', CASE WHEN ch.refund_propagation_status = 'proposed' THEN ch.refund_propagation_kind END,
            'exclusionReason', ch.exclusion_reason,
            'status', ch.raw_charge->>'status',
            'captured', (ch.raw_charge->>'captured')::boolean
          ) ORDER BY ch.gross_amount DESC)
          FROM stripe_staged_charges ch
          WHERE ch.stripe_payout_id = p.id
            AND (ch.raw_charge->>'status' = 'succeeded' OR ch.exclusion_reason IS NOT NULL)
        ), '[]'::jsonb) AS charges,
        COALESCE((
          SELECT jsonb_agg(item ORDER BY item->>'stagedPaymentId')
          FROM (
            SELECT jsonb_build_object(
              'stagedPaymentId', sp.id, 'role', 'component', 'reference', sp.raw_reference,
              'lineDescription', sp.line_description, 'memo', sp.qb_transaction_memo,
              'amount', sp.amount::text, 'dateReceived', sp.date_received::text,
              'paymentMethod', ${inferredPaymentMethod("sp")}, 'payerName', sp.payer_name,
              'qbTransactionMemo', sp.qb_transaction_memo, 'qbLocation', sp.qb_location,
              'revenueLocation', sp.revenue_location, 'qbDocNumber', sp.qb_doc_number,
              'qbCheckNumber', sp.qb_check_number, 'entityId', sp.entity_id,
              'qbPayerType', sp.qb_payer_type, 'qbEntityType', sp.qb_entity_type,
              'qbEntityId', sp.qb_entity_id, 'qbDepositId', sp.qb_deposit_id,
              'exclusionReason', sp.exclusion_reason,
              'unconfirmed', false, 'source', 'bank_spine'
            ) AS item
            FROM payment_units qu JOIN bank_deposit_components qc ON qc.payment_unit_id = qu.id
            JOIN staged_payments sp ON sp.id = qu.source_staged_payment_id
            WHERE qc.bank_deposit_id = d.id
            UNION ALL
            SELECT jsonb_build_object(
              'stagedPaymentId', psp.id, 'role', 'deposit', 'reference', psp.raw_reference,
              'lineDescription', psp.line_description, 'memo', psp.qb_transaction_memo,
              'amount', psp.amount::text, 'dateReceived', psp.date_received::text,
              'paymentMethod', ${inferredPaymentMethod("psp")}, 'payerName', psp.payer_name,
              'qbTransactionMemo', psp.qb_transaction_memo, 'qbLocation', psp.qb_location,
              'revenueLocation', psp.revenue_location, 'qbDocNumber', psp.qb_doc_number,
              'qbCheckNumber', psp.qb_check_number, 'entityId', psp.entity_id,
              'qbPayerType', psp.qb_payer_type, 'qbEntityType', psp.qb_entity_type,
              'qbEntityId', psp.qb_entity_id, 'qbDepositId', psp.qb_deposit_id,
              'exclusionReason', psp.exclusion_reason,
              'unconfirmed', false, 'source', 'bank_spine'
            ) AS item
            FROM staged_payments psp
            JOIN stripe_payouts pp ON pp.id = psp.settled_stripe_payout_id
            WHERE pp.bank_deposit_id = d.id
            UNION ALL
            SELECT jsonb_build_object(
              'stagedPaymentId', qsp.id, 'role', 'component', 'reference', qsp.raw_reference,
              'lineDescription', qsp.line_description, 'memo', qsp.qb_transaction_memo,
              'amount', qsp.amount::text, 'dateReceived', qsp.date_received::text,
              'paymentMethod', ${inferredPaymentMethod("qsp")}, 'payerName', qsp.payer_name,
              'qbTransactionMemo', qsp.qb_transaction_memo, 'qbLocation', qsp.qb_location,
              'revenueLocation', qsp.revenue_location, 'qbDocNumber', qsp.qb_doc_number,
              'qbCheckNumber', qsp.qb_check_number, 'entityId', qsp.entity_id,
              'qbPayerType', qsp.qb_payer_type, 'qbEntityType', qsp.qb_entity_type,
              'qbEntityId', qsp.qb_entity_id, 'qbDepositId', qsp.qb_deposit_id,
              'exclusionReason', qsp.exclusion_reason,
              'depositQboComponentId', dqc.id, 'unconfirmed', NOT dqc.confirmed,
              'source', 'qbo_provisional', 'matchBasis', dqc.match_basis
            ) AS item
            FROM deposit_qbo_components dqc
            JOIN staged_payments qsp ON qsp.id = dqc.staged_payment_id
            WHERE dqc.bank_deposit_id = d.id
          ) records
        ), '[]'::jsonb) AS qb_records,
        COALESCE((
          SELECT jsonb_agg(item ORDER BY item->>'id')
          FROM (
            SELECT jsonb_build_object(
              'id', qc.id, 'stagedPaymentId', qc.staged_payment_id,
              'disposition', qc.disposition, 'expected', qc.expected,
              'actual', qc.actual, 'note', qc.note,
              'dateReceived', sp.date_received::text, 'amount', sp.amount::text,
              'qbTransactionMemo', sp.qb_transaction_memo, 'lineDescription', sp.line_description,
              'qbLocation', sp.qb_location, 'revenueLocation', sp.revenue_location,
              'qbDocNumber', sp.qb_doc_number, 'qbCheckNumber', sp.qb_check_number,
              'payerName', sp.payer_name, 'qbPayerType', sp.qb_payer_type,
              'entityId', sp.entity_id, 'qbEntityType', sp.qb_entity_type,
              'qbDepositId', sp.qb_deposit_id, 'exclusionReason', sp.exclusion_reason
            ) AS item
            FROM qbo_accounting_checks qc
            JOIN staged_payments sp ON sp.id = qc.staged_payment_id
            JOIN payment_units qu ON qu.source_staged_payment_id = qc.staged_payment_id
            JOIN bank_deposit_components qdc ON qdc.payment_unit_id = qu.id
            WHERE qdc.bank_deposit_id = d.id
            UNION ALL
            SELECT jsonb_build_object(
              'id', pqc.id, 'stagedPaymentId', pqc.staged_payment_id,
              'disposition', pqc.disposition, 'expected', pqc.expected,
              'actual', pqc.actual, 'note', pqc.note,
              'dateReceived', psp.date_received::text, 'amount', psp.amount::text,
              'qbTransactionMemo', psp.qb_transaction_memo, 'lineDescription', psp.line_description,
              'qbLocation', psp.qb_location, 'revenueLocation', psp.revenue_location,
              'qbDocNumber', psp.qb_doc_number, 'qbCheckNumber', psp.qb_check_number,
              'payerName', psp.payer_name, 'qbPayerType', psp.qb_payer_type,
              'entityId', psp.entity_id, 'qbEntityType', psp.qb_entity_type,
              'qbDepositId', psp.qb_deposit_id, 'exclusionReason', psp.exclusion_reason
            ) AS item
            FROM qbo_accounting_checks pqc
            JOIN staged_payments psp ON psp.id = pqc.staged_payment_id
            JOIN stripe_payouts pp ON pp.id = psp.settled_stripe_payout_id
            WHERE pp.bank_deposit_id = d.id
          ) checks
        ), '[]'::jsonb) AS accounting_checks
      FROM bank_deposits d
      LEFT JOIN stripe_payouts p ON p.bank_deposit_id = d.id
      LEFT JOIN bank_transactions bt ON bt.id = d.source_bank_transaction_id
      WHERE d.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      GROUP BY d.id, p.id, bt.payee, bt.ref_no, bt.txn_type
    `);
    const byId = new Map((rowResult.rows as unknown as DepositRow[]).map((r) => [r.id, r]));
    const data = slim.flatMap((s) => {
      const r = byId.get(s.id);
      if (!r) return [];
      const gifts = r.gifts.map((g) => ({
        ...g,
        donorName: maskName(
          g.donorName,
          { anonymous: g.donorAnonymous, ownerUserId: g.donorOwnerUserId },
          viewer,
        ),
      }));
      const state = stateForDeposit(
        { ...s, payout_id: r.payout_id } as SlimRow & { payout_id: string | null },
        r.units,
        gifts,
        r.accounting_checks,
        r.qb_records,
      );
      const lenses = depositLenses(s, state, s);
      return [{
        id: `bank_deposit:${r.id}`,
        kind: "bank_deposit" as const,
        anchorId: r.id,
        status: state.information.state,
        date: r.deposit_date,
        title: r.memo || r.reference || r.account,
        lenses,
        bank: {
          amount: r.amount,
          currency: r.currency,
          account: r.account,
          location: r.location,
          reference: r.reference,
          memo: r.memo,
          payee: r.payee,
          refNo: r.ref_no,
          txnType: r.txn_type,
        },
        composition: {
          kind: r.payout_id
            ? "stripe_payout"
            : s.f_ambiguous && /stripe\s+transfer/i.test(r.memo ?? "")
              ? "stripe_unlinked"
              : r.components.length
                ? "components"
                : r.provisional_components.length
                  ? "qbo_provisional"
                  : "unresolved",
          payoutId: r.payout_id,
          payoutDate: r.payout_date,
          grossTotal: r.payout_gross,
          feeTotal: r.payout_fee,
          refundTotal: r.payout_refund_total,
          adjustmentTotal: r.payout_adjustment,
          netTotal: r.payout_net,
          chargeCount: r.payout_charge_count,
          payoutAmbiguous: r.payout_ambiguous,
          explainedAmount: r.payout_id
            ? r.amount
            : [...r.components, ...r.provisional_components].reduce((sum, c) => sum + amount(c.amount), 0).toFixed(2),
          unexplainedAmount: r.payout_id
            ? "0.00"
            : Math.max(0, amount(r.amount) - [...r.components, ...r.provisional_components].reduce((sum, c) => sum + amount(c.amount), 0)).toFixed(2),
          components: [...r.components, ...r.provisional_components],
          units: r.units,
        },
        gifts,
        charges: r.charges,
        qbRecords: r.qb_records,
        accountingChecks: r.accounting_checks,
        bankExclusion: r.bank_exclusion_reason
          ? { reason: r.bank_exclusion_reason, note: r.bank_exclusion_note }
          : null,
        notFundraisingReason: r.not_fundraising_reason,
        coverage: {
          evidenceRecords: [],
          donorPurpose: {
            crmLinkage: {
              grain: r.units.length ? "unit" : "none",
              complete: r.units.length > 0 && r.units.every((u) => u.countedGiftIds.length > 0),
              coveredIds: r.units.filter((u) => u.countedGiftIds.length > 0).map((u) => u.paymentUnitId),
              uncoveredIds: r.units.filter((u) => u.countedGiftIds.length === 0).map((u) => u.paymentUnitId),
              expectedAmount: r.amount,
              representedAmount: gifts.reduce((sum, g) => sum + amount(g.amount), 0).toFixed(2),
              representationNote: null,
            },
            crmRecordCompleteness: buildCrmRecordCompleteness(
              gifts.map((g) => ({
                giftId: g.giftId,
                opportunityId: g.opportunityId,
                name: g.name,
                donorName: g.donorName,
                donorKind: g.donorKind,
                donorId: g.donorId,
                amount: g.amount,
                dateReceived: g.dateReceived,
                quickbooksTie: null,
                donorbox: g.donorbox,
                grantLetter: g.grantLetter,
                codingForm: g.codingForm,
                recordComplete: g.recordComplete,
                satisfiedBy: g.recordComplete ? "donor_and_allocations" : null,
                crmReason: g.recordComplete ? null : "missing_donor",
                linkedChargeIds: g.linkedChargeIds,
                linkedStagedPaymentIds: g.linkedStagedPaymentIds,
              })),
            ),
            complete: gifts.every((g) => g.recordComplete) && r.units.length > 0 && r.units.every((u) => u.countedGiftIds.length > 0),
          },
          paymentTransaction: {
            grain: r.payout_id || r.units.length ? "unit" : "none",
            complete: Boolean(r.payout_id || r.units.length),
            coveredIds: r.payout_id ? r.charges.map((c) => String(c.chargeId)) : r.units.map((u) => u.paymentUnitId),
            uncoveredIds: [],
            expectedAmount: r.amount,
            representedAmount: r.amount,
            representationNote: null,
          },
          accountingEvidence: {
            grain: r.payout_id || r.accounting_checks.length ? "bundle" : "none",
            complete: Boolean(r.payout_id || r.accounting_checks.length),
            coveredIds: r.accounting_checks.map((c) => String(c.stagedPaymentId)),
            uncoveredIds: [],
            expectedAmount: r.amount,
            representedAmount: r.amount,
            representationNote: null,
          },
          complete: rowCompleteFromState(state),
          state,
        },
      }];
    });
    return res.json({
      data,
      lensCounts: {
        all_open: counts.all_open ?? 0,
        unresolved_composition: counts.unresolved_composition ?? 0,
        ambiguous_pairing: counts.ambiguous_pairing ?? 0,
        needs_gift: counts.needs_gift ?? 0,
        accounting_corrections: counts.accounting_corrections ?? 0,
        refunds: counts.refunds ?? 0,
        completed: counts.completed ?? 0,
        not_fundraising: counts.not_fundraising ?? 0,
      },
      pagination: { page, limit, total: counts[lens] ?? 0 },
      viewerCanManageAccounting: viewerCanManageAccounting(req),
    });
  }),
);

router.post(
  "/reconciliation/deposits/:bankDepositId/exclusion",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = parseOrBadRequest(SetBankDepositExclusionParams, req.params, res);
    if (!params) return;
    const body = parseOrBadRequest(SetBankDepositExclusionBody, req.body, res);
    if (!body) return;

    const [deposit] = await db
      .select({ id: bankDeposits.id })
      .from(bankDeposits)
      .where(sql`${bankDeposits.id} = ${params.bankDepositId}`)
      .limit(1);
    if (!deposit) {
      notFound(res, "bank deposit");
      return;
    }

    const [row] = await db
      .insert(bankDepositExclusions)
      .values({
        id: `bdex_${newId()}`,
        bankDepositId: params.bankDepositId,
        reason: body.reason,
        note: body.note ?? null,
        createdByUserId: user.id,
      })
      .onConflictDoUpdate({
        target: bankDepositExclusions.bankDepositId,
        set: {
          reason: body.reason,
          note: body.note ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({
        reason: bankDepositExclusions.reason,
        note: bankDepositExclusions.note,
      });
    res.json(row);
  }),
);

router.delete(
  "/reconciliation/deposits/:bankDepositId/exclusion",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(ClearBankDepositExclusionParams, req.params, res);
    if (!params) return;
    const [deposit] = await db
      .select({ id: bankDeposits.id })
      .from(bankDeposits)
      .where(sql`${bankDeposits.id} = ${params.bankDepositId}`)
      .limit(1);
    if (!deposit) {
      notFound(res, "bank deposit");
      return;
    }
    await db
      .delete(bankDepositExclusions)
      .where(sql`${bankDepositExclusions.bankDepositId} = ${params.bankDepositId}`);
    res.status(204).send();
  }),
);

router.post(
  "/reconciliation/deposit-components/:id/exclude",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(ExcludeBankDepositComponentParams, req.params, res);
    if (!params) return;
    const body = parseOrBadRequest(ExcludeBankDepositComponentBody, req.body, res);
    if (!body) return;

    const [component] = await db
      .select({
        id: bankDepositComponents.id,
        exclusionReason: bankDepositComponents.exclusionReason,
      })
      .from(bankDepositComponents)
      .where(sql`${bankDepositComponents.id} = ${params.id}`)
      .limit(1);
    if (!component) {
      notFound(res, "bank deposit component");
      return;
    }

    const [row] = await db
      .update(bankDepositComponents)
      .set({
        exclusionReason: body.exclusionReason,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(sql`${bankDepositComponents.id} = ${params.id}`)
      .returning({
        id: bankDepositComponents.id,
        exclusionReason: bankDepositComponents.exclusionReason,
        classificationSource: bankDepositComponents.classificationSource,
      });
    res.json(row);
  }),
);

router.post(
  "/reconciliation/deposit-components/:id/re-include",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(ReIncludeBankDepositComponentParams, req.params, res);
    if (!params) return;

    const [component] = await db
      .select({
        id: bankDepositComponents.id,
        exclusionReason: bankDepositComponents.exclusionReason,
      })
      .from(bankDepositComponents)
      .where(sql`${bankDepositComponents.id} = ${params.id}`)
      .limit(1);
    if (!component) {
      notFound(res, "bank deposit component");
      return;
    }
    if (!component.exclusionReason) {
      res.status(409).json({
        error: "not_excluded",
        message: "Only excluded bank deposit components can be re-included.",
      });
      return;
    }

    const [row] = await db
      .update(bankDepositComponents)
      .set({
        exclusionReason: null,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(sql`${bankDepositComponents.id} = ${params.id}`)
      .returning({
        id: bankDepositComponents.id,
        exclusionReason: bankDepositComponents.exclusionReason,
        classificationSource: bankDepositComponents.classificationSource,
      });
    res.json(row);
  }),
);

router.post(
  "/reconciliation/deposit-qbo-components/:id/confirm",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = await db.execute(sql`
      UPDATE deposit_qbo_components
      SET confirmed = true,
          confirmed_by_user_id = ${user.id},
          confirmed_at = now(),
          updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING id, confirmed
    `);
    const row = (result.rows as Array<{ id: string; confirmed: boolean }>)[0];
    if (!row) {
      res.status(404).json({ error: "not_found", message: "Provisional QBO component not found." });
      return;
    }
    res.json(row);
  }),
);

router.delete(
  "/reconciliation/deposit-qbo-components/:id",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const result = await db.execute(sql`
      DELETE FROM deposit_qbo_components
      WHERE id = ${req.params.id}
      RETURNING id
    `);
    if (!result.rows.length) {
      res.status(404).json({ error: "not_found", message: "Provisional QBO component not found." });
      return;
    }
    res.status(204).send();
  }),
);

router.get(
  "/reconciliation/deposits/:bankDepositId/candidate-payouts",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const depositResult = await db.execute(sql`
      SELECT id, amount::text AS amount, currency, deposit_date::text AS deposit_date
      FROM bank_deposits
      WHERE id = ${req.params.bankDepositId}
    `);
    const deposit = (depositResult.rows as Array<{
      id: string;
      amount: string;
      currency: string;
      deposit_date: string;
    }>)[0];
    if (!deposit) {
      res.status(404).json({ error: "not_found", message: "Bank deposit not found." });
      return;
    }
    const result = await db.execute(sql`
      SELECT
        p.id AS payout_id,
        p.arrival_date::text AS arrival_date,
        p.amount::text AS amount,
        p.currency,
        p.bank_deposit_id AS current_bank_deposit_id,
        bd.deposit_date::text AS current_deposit_date,
        COALESCE(p.ambiguous_bank_match, false) AS ambiguous
      FROM stripe_payouts p
      LEFT JOIN bank_deposits bd ON bd.id = p.bank_deposit_id
      WHERE p.status = 'paid'
        AND p.amount = ${deposit.amount}::numeric
        AND upper(p.currency) = upper(${deposit.currency})
        AND p.arrival_date BETWEEN (${deposit.deposit_date}::date - INTERVAL '10 days')
          AND (${deposit.deposit_date}::date + INTERVAL '2 days')
        AND (
          p.bank_deposit_id IS NULL
          OR (p.bank_deposit_id <> ${deposit.id} AND p.ambiguous_bank_match = true)
        )
      ORDER BY p.arrival_date ASC, p.id ASC
    `);
    res.json({
      data: (result.rows as Array<{
        payout_id: string;
        arrival_date: string;
        amount: string;
        currency: string;
        current_bank_deposit_id: string | null;
        current_deposit_date: string | null;
        ambiguous: boolean;
      }>).map((row) => ({
        payoutId: row.payout_id,
        arrivalDate: row.arrival_date,
        amount: row.amount,
        currency: row.currency,
        currentBankDepositId: row.current_bank_deposit_id,
        currentDepositDate: row.current_deposit_date,
        ambiguous: row.ambiguous,
      })),
    });
  }),
);

router.get(
  "/reconciliation/payouts/:payoutId/candidate-deposits",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const payoutResult = await db.execute(sql`
      SELECT id, amount::text AS amount, currency, arrival_date::text AS arrival_date
      FROM stripe_payouts
      WHERE id = ${req.params.payoutId}
    `);
    const payout = (payoutResult.rows as Array<{
      id: string;
      amount: string;
      currency: string;
      arrival_date: string | null;
    }>)[0];
    if (!payout) {
      res.status(404).json({ error: "not_found", message: "Stripe payout not found." });
      return;
    }
    const result = await db.execute(sql`
      SELECT
        d.id AS bank_deposit_id,
        d.deposit_date::text AS deposit_date,
        d.amount::text AS amount,
        d.currency,
        d.memo,
        (p.bank_deposit_id IS NOT NULL) AS claimed,
        COALESCE(p.ambiguous_bank_match, false) AS ambiguous
      FROM bank_deposits d
      LEFT JOIN stripe_payouts p ON p.bank_deposit_id = d.id
      WHERE d.amount = ${payout.amount}::numeric
        AND upper(d.currency) = upper(${payout.currency})
        AND ${payout.arrival_date ? sql`d.deposit_date >= ${payout.arrival_date}::date AND d.deposit_date <= (${payout.arrival_date}::date + INTERVAL '10 days')` : sql`false`}
        AND (
          p.id IS NULL
          OR (p.id <> ${payout.id} AND p.ambiguous_bank_match = true)
        )
        AND NOT EXISTS (
          SELECT 1 FROM bank_deposit_components c
          WHERE c.bank_deposit_id = d.id
        )
      ORDER BY d.deposit_date ASC, d.id ASC
    `);
    res.json({
      data: (result.rows as Array<{
        bank_deposit_id: string;
        deposit_date: string;
        amount: string;
        currency: string;
        memo: string | null;
        claimed: boolean;
        ambiguous: boolean;
      }>).map((row) => ({
        bankDepositId: row.bank_deposit_id,
        depositDate: row.deposit_date,
        amount: row.amount,
        currency: row.currency,
        memo: row.memo,
        claimed: row.claimed,
        ambiguous: row.ambiguous,
      })),
    });
  }),
);

router.post(
  "/reconciliation/payouts/:payoutId/bank-deposit",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const payoutId = req.params.payoutId;
    const depositId = typeof req.body?.bankDepositId === "string" ? req.body.bankDepositId : "";
    const payoutResult = await db.execute(sql`
      SELECT id, amount::text AS amount, currency
      FROM stripe_payouts
      WHERE id = ${payoutId}
    `);
    const payout = (payoutResult.rows as Array<{
      id: string;
      amount: string | null;
      currency: string | null;
    }>)[0];
    if (!payout) {
      res.status(404).json({ error: "not_found", message: "Stripe payout not found." });
      return;
    }
    const depositResult = await db.execute(sql`
      SELECT id, amount::text AS amount, currency
      FROM bank_deposits
      WHERE id = ${depositId}
    `);
    const deposit = (depositResult.rows as Array<{
      id: string;
      amount: string;
      currency: string;
    }>)[0];
    if (!deposit) {
      res.status(404).json({ error: "not_found", message: "Bank deposit not found." });
      return;
    }
    const occupiedResult = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM stripe_payouts
        WHERE bank_deposit_id = ${depositId} AND id <> ${payoutId}
      ) OR EXISTS (
        SELECT 1 FROM bank_deposit_components WHERE bank_deposit_id = ${depositId}
      ) AS occupied
    `);
    if ((occupiedResult.rows[0] as { occupied: boolean } | undefined)?.occupied) {
      res.status(409).json({
        error: "deposit_not_free",
        message: "This deposit already has a payout or counted components.",
      });
      return;
    }
    if (
      payout.amount !== deposit.amount ||
      !payout.currency ||
      payout.currency.toUpperCase() !== deposit.currency.toUpperCase()
    ) {
      res.status(400).json({
        error: "amount_mismatch",
        message: "The payout amount and currency must match the bank deposit.",
      });
      return;
    }
    const updateResult = await db.execute(sql`
      UPDATE stripe_payouts
      SET bank_deposit_id = ${depositId},
          ambiguous_bank_match = false,
          bank_matched_at = now(),
          updated_at = now()
      WHERE id = ${payoutId}
      RETURNING id
    `);
    if (!updateResult.rows.length) {
      res.status(404).json({ error: "not_found", message: "Stripe payout not found." });
      return;
    }
    res.json({ payoutId, bankDepositId: depositId });
  }),
);

router.delete(
  "/reconciliation/payouts/:payoutId/bank-deposit",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const result = await db.execute(sql`
      UPDATE stripe_payouts
      SET bank_deposit_id = NULL,
          ambiguous_bank_match = false,
          bank_matched_at = now(),
          updated_at = now()
      WHERE id = ${req.params.payoutId} AND bank_deposit_id IS NOT NULL
      RETURNING id
    `);
    if (!result.rows.length) {
      res.status(404).json({ error: "not_found", message: "No payout is linked to this deposit." });
      return;
    }
    res.status(204).send();
  }),
);

router.post(
  "/reconciliation/payouts/:payoutId/confirm-bank-match",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const result = await db.execute(sql`
      UPDATE stripe_payouts
      SET ambiguous_bank_match = false,
          bank_matched_at = now(),
          updated_at = now()
      WHERE id = ${req.params.payoutId}
        AND bank_deposit_id IS NOT NULL
      RETURNING id
    `);
    if (!result.rows.length) {
      res.status(404).json({
        error: "not_found",
        message: "Stripe payout not found or is not currently linked to a bank deposit.",
      });
      return;
    }
    res.json({ payoutId: req.params.payoutId });
  }),
);

export default router;
