import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  bankDepositComponents,
  bankDepositExclusions,
  bankDeposits,
  qboAccountingChecks,
  sourceLinks,
  sourceLinkId,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  asyncHandler,
  newId,
  notFound,
  parseOrBadRequest,
  parsePagination,
} from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import {
  requireFinance,
  viewerCanManageAccounting,
} from "../../lib/financeGuard";
import { getViewer, maskName } from "../../lib/identityVisibility";
import {
  ClearBankDepositExclusionParams,
  AddBankDepositComponentBody,
  AddBankDepositComponentParams,
  AttachDepositQboEvidenceBody,
  AttachDepositQboEvidenceParams,
  FlagQboAccountingErrorBody,
  ExcludeBankDepositComponentBody,
  ExcludeBankDepositComponentParams,
  ListDepositCandidatePaymentUnitsParams,
  ListDepositCandidatePaymentUnitsQueryParams,
  RemoveManualBankDepositComponentParams,
  SetBankDepositComponentSourceStagedPaymentParams,
  SetBankDepositComponentSourceStagedPaymentBody,
  ReIncludeBankDepositComponentParams,
  SetBankDepositExclusionBody,
  SetBankDepositExclusionParams,
  SetQboAccountingCheckDispositionBody,
} from "@workspace/api-zod";
import {
  QB_DOCUMENTATION_COMPLETE_SQL,
  lensFlagsFromState,
  rowCompleteFromState,
  type CrmCardEntry,
  type QbCardEntry,
  type TransactionEntry,
  type WorkbenchRowState,
} from "./workbenchRowState";
import { deriveDepositWorkbenchState } from "./workbenchDepositState";
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
  all_open: "(NOT f_completed AND NOT f_not_fundraising)",
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

type DepositCharge = Record<string, unknown> & {
  chargeId: string;
  amount: string | null;
  linkedGiftId: string | null;
  paymentUnitId: string | null;
  paymentUnitLifecycle: string | null;
  refunded: boolean;
  disputed: boolean;
  amountRefunded: string | null;
  refundPropagationStatus: string | null;
  exclusionReason: string | null;
  status: string | null;
  qboRecords?: NodeQbRecord[];
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
    qboRecords?: NodeQbRecord[];
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
    qboRecords?: NodeQbRecord[];
  }>;
  charges: DepositCharge[];
  qb_records: Array<Record<string, unknown>>;
  accounting_checks: Array<Record<string, unknown>>;
};

type NodeQbRecord = {
  stagedPaymentId: string;
  role: "component" | "provisional" | "fee" | "charge_tie";
  reference: string | null;
  lineDescription: string | null;
  memo: string | null;
  amount: string | null;
  dateReceived: string | null;
  paymentMethod?: string | null;
  linkedChargeId?: string | null;
  componentId?: string | null;
  paymentUnitId?: string | null;
  accountingCheckId?: string | null;
  payerName?: string | null;
  qbEntityType?: string | null;
  qbEntityId?: string | null;
  qbTransactionMemo?: string | null;
  qbLocation?: string | null;
  revenueLocation?: string | null;
  qbDocNumber?: string | null;
  qbCheckNumber?: string | null;
  entityId?: string | null;
  qbPayerType?: string | null;
  exclusionReason?: string | null;
};

function amount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function hydrateQboRollups(rows: DepositRow[]): Promise<void> {
  const chargeIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.charges
          .map((charge) => String(charge.chargeId ?? ""))
          .filter(Boolean),
      ),
    ),
  ];
  const componentRefs = rows.flatMap((row) =>
    [...row.components, ...row.provisional_components]
      .filter((component) => component.stagedPaymentId)
      .map((component) => ({
        stagedPaymentId: component.stagedPaymentId as string,
        componentId: component.componentId,
        paymentUnitId: component.paymentUnitId,
        role:
          component.source === "qbo_provisional"
            ? ("provisional" as const)
            : ("component" as const),
      })),
  );
  const stagedPaymentIds = [
    ...new Set(componentRefs.map((ref) => ref.stagedPaymentId)),
  ];
  if (chargeIds.length === 0 && stagedPaymentIds.length === 0) return;
  const stagedFilter = stagedPaymentIds.length
    ? sql`sp.id IN (${sql.join(
        stagedPaymentIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`FALSE`;
  const chargeFilter = chargeIds.length
    ? sql`sl.stripe_charge_id IN (${sql.join(
        chargeIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql`FALSE`;

  const result = await db.execute(sql`
    SELECT
      sp.id AS staged_payment_id,
      sp.raw_reference,
      sp.line_description,
      sp.qb_transaction_memo,
      sp.amount::text AS amount,
      sp.date_received::text AS date_received,
      sp.qb_payment_method,
      sp.payer_name,
      sp.qb_entity_type,
      sp.qb_entity_id,
      sp.qb_location,
      sp.revenue_location,
      sp.qb_doc_number,
      sp.qb_check_number,
      sp.entity_id,
      sp.qb_payer_type,
      sp.exclusion_reason,
      sl.link_type,
      sl.stripe_charge_id,
      qc.id AS accounting_check_id
    FROM staged_payments sp
    LEFT JOIN source_links sl
      ON sl.qb_staged_payment_id = sp.id
     AND sl.link_type IN ('charge_qb_tie', 'charge_fee_row')
     AND sl.lifecycle IN ('proposed', 'confirmed')
    LEFT JOIN qbo_accounting_checks qc ON qc.staged_payment_id = sp.id
    WHERE ${stagedFilter} OR ${chargeFilter}
  `);

  const componentByStaged = new Map(
    componentRefs.map((ref) => [ref.stagedPaymentId, ref]),
  );
  const recordsByCharge = new Map<string, NodeQbRecord[]>();
  const recordsByStaged = new Map<string, NodeQbRecord[]>();
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const stagedPaymentId = String(raw.staged_payment_id);
    const linkType =
      raw.link_type === "charge_fee_row"
        ? "fee"
        : raw.link_type === "charge_qb_tie"
          ? "charge_tie"
          : null;
    const componentRef = componentByStaged.get(stagedPaymentId);
    const role = linkType ?? componentRef?.role;
    if (!role) continue;
    const record: NodeQbRecord = {
      stagedPaymentId,
      role,
      reference: (raw.raw_reference as string | null) ?? null,
      lineDescription: (raw.line_description as string | null) ?? null,
      memo: (raw.qb_transaction_memo as string | null) ?? null,
      amount: (raw.amount as string | null) ?? null,
      dateReceived: (raw.date_received as string | null) ?? null,
      paymentMethod: (raw.qb_payment_method as string | null) ?? null,
      linkedChargeId: (raw.stripe_charge_id as string | null) ?? null,
      componentId: componentRef?.componentId ?? null,
      paymentUnitId: componentRef?.paymentUnitId ?? null,
      accountingCheckId: (raw.accounting_check_id as string | null) ?? null,
      payerName: (raw.payer_name as string | null) ?? null,
      qbEntityType: (raw.qb_entity_type as string | null) ?? null,
      qbEntityId: (raw.qb_entity_id as string | null) ?? null,
      qbTransactionMemo: (raw.qb_transaction_memo as string | null) ?? null,
      qbLocation: (raw.qb_location as string | null) ?? null,
      revenueLocation: (raw.revenue_location as string | null) ?? null,
      qbDocNumber: (raw.qb_doc_number as string | null) ?? null,
      qbCheckNumber: (raw.qb_check_number as string | null) ?? null,
      entityId: (raw.entity_id as string | null) ?? null,
      qbPayerType: (raw.qb_payer_type as string | null) ?? null,
      exclusionReason: (raw.exclusion_reason as string | null) ?? null,
    };
    const stagedRecords = recordsByStaged.get(stagedPaymentId) ?? [];
    if (
      !stagedRecords.some(
        (existing) =>
          existing.role === record.role &&
          existing.linkedChargeId === record.linkedChargeId,
      )
    ) {
      stagedRecords.push(record);
      recordsByStaged.set(stagedPaymentId, stagedRecords);
    }
    if (record.linkedChargeId) {
      const chargeRecords = recordsByCharge.get(record.linkedChargeId) ?? [];
      if (
        !chargeRecords.some(
          (existing) =>
            existing.stagedPaymentId === record.stagedPaymentId &&
            existing.role === record.role,
        )
      ) {
        chargeRecords.push(record);
        recordsByCharge.set(record.linkedChargeId, chargeRecords);
      }
    }
  }

  for (const row of rows) {
    for (const component of [
      ...row.components,
      ...row.provisional_components,
    ]) {
      component.qboRecords = component.stagedPaymentId
        ? (recordsByStaged.get(component.stagedPaymentId) ?? [])
        : [];
    }
    for (const charge of row.charges) {
      charge.qboRecords = charge.chargeId
        ? (recordsByCharge.get(String(charge.chargeId)) ?? [])
        : [];
    }
    // Records already rendered under this deposit's component or charge cards
    // are not repeated under the gift rollup.
    const rowComponentStaged = new Set(
      [...row.components, ...row.provisional_components]
        .map((component) => component.stagedPaymentId)
        .filter((id): id is string => Boolean(id)),
    );
    const rowChargeIds = new Set(
      row.charges
        .map((charge) => String(charge.chargeId ?? ""))
        .filter(Boolean),
    );
    for (const gift of row.gifts) {
      const giftRecords = [
        ...gift.linkedChargeIds
          .filter((id) => !rowChargeIds.has(id))
          .flatMap((id) => recordsByCharge.get(id) ?? []),
        ...gift.linkedStagedPaymentIds
          .filter((id) => !rowComponentStaged.has(id))
          .flatMap((id) => recordsByStaged.get(id) ?? []),
      ];
      gift.qboRecords = giftRecords.filter(
        (record, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.stagedPaymentId === record.stagedPaymentId &&
              candidate.role === record.role &&
              candidate.linkedChargeId === record.linkedChargeId,
          ) === index,
      );
    }
  }
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

function chargeIsFullyReversed(charge: DepositCharge): boolean {
  const gross = amount(charge.amount);
  const refunded = amount(charge.amountRefunded);
  return (
    charge.disputed === true ||
    charge.paymentUnitLifecycle === "refunded" ||
    (charge.refunded === true && gross > 0 && refunded >= gross - 0.005)
  );
}

function stateForDeposit(
  row: SlimRow,
  deposit: DepositRow,
  gifts: DepositRow["gifts"],
) {
  const componentByUnit = new Map(
    deposit.components
      .filter((component) => component.paymentUnitId)
      .map((component) => [component.paymentUnitId as string, component]),
  );

  const transactions: Array<{
    entry: TransactionEntry;
    linkedToCrm: boolean;
  }> = deposit.payout_id
    ? deposit.charges.map((charge) => {
        const excluded = Boolean(charge.exclusionReason);
        const fullyReversed = chargeIsFullyReversed(charge);
        const linkedToCrm = Boolean(charge.linkedGiftId);
        const refundProposed = charge.refundPropagationStatus === "proposed";
        const state: TransactionEntry["state"] = excluded
          ? "excluded"
          : fullyReversed
            ? "refunded"
            : refundProposed
              ? "refund_anticipated"
              : linkedToCrm
                ? "matched"
                : "unmatched";
        const refundStatus: TransactionEntry["refundStatus"] = refundProposed
          ? "anticipated"
          : fullyReversed || amount(charge.amountRefunded) > 0
            ? "refunded"
            : "none";
        return {
          linkedToCrm,
          entry: {
            transactionId: charge.paymentUnitId ?? charge.chargeId,
            livePayment: !excluded && !fullyReversed,
            refundStatus,
            state,
          },
        };
      })
    : deposit.units.map((unit) => {
        const component = componentByUnit.get(unit.paymentUnitId);
        const excluded = Boolean(component?.exclusionReason);
        const fullyReversed =
          unit.lifecycle === "refunded" || unit.lifecycle === "disputed";
        const linkedToCrm = unit.countedGiftIds.length > 0;
        const state: TransactionEntry["state"] = excluded
          ? "excluded"
          : fullyReversed
            ? "refunded"
            : linkedToCrm
              ? "matched"
              : "unmatched";
        return {
          linkedToCrm,
          entry: {
            transactionId: unit.paymentUnitId,
            livePayment: !excluded && !fullyReversed,
            refundStatus:
              unit.lifecycle === "refunded" ||
              unit.lifecycle === "partially_refunded"
                ? "refunded"
                : "none",
            state,
          },
        };
      });

  const crmCards: CrmCardEntry[] = gifts.map((g) => ({
    giftId: g.giftId,
    recordComplete: g.recordComplete,
    state:
      g.linkedStagedPaymentIds.length || g.linkedChargeIds.length
        ? g.recordComplete
          ? "matched_complete"
          : "matched_incomplete"
        : g.recordComplete
          ? "unmatched_complete"
          : "unmatched_incomplete",
    satisfiedBy: g.recordComplete
      ? "donor_allocations_and_supporting_documents"
      : null,
  }));

  const qbCards: QbCardEntry[] = deposit.accounting_checks.map((c) => ({
    qbRecordId: String(c.stagedPaymentId),
    state:
      c.disposition === "consistent" || c.disposition === "corrected"
        ? "matched_complete"
        : c.disposition === "accepted_historical"
          ? "excluded"
          : "matched_conflict",
    isTransactionEvidence: false,
  }));

  const compositionPresent = Boolean(
    deposit.payout_id ||
    deposit.components.length ||
    deposit.provisional_components.length,
  );
  const compositionComplete =
    compositionPresent && !row.f_unresolved && !row.f_ambiguous;
  const accountingCorrection = deposit.accounting_checks.some(
    (check) => check.disposition === "correction_needed",
  );

  return deriveDepositWorkbenchState({
    composition: {
      present: compositionPresent,
      complete: compositionComplete,
      grain: deposit.payout_id
        ? "bundle"
        : deposit.components.length > 0
          ? "unit"
          : "none",
      relationshipCount: deposit.payout_id ? 1 : deposit.components.length,
    },
    transactions,
    crmCards,
    qbCards,
    accountingEvidencePresent:
      deposit.qb_records.length > 0 || deposit.accounting_checks.length > 0,
    accountingCorrection,
    excluded: row.f_not_fundraising,
    conflict: row.f_ambiguous,
    attentionRequired: row.f_refund,
    settlementLinkState: deposit.payout_id ? "confirmed" : undefined,
  });
}

function depositLenses(
  row: SlimRow,
  state: WorkbenchRowState,
  flags: Pick<
    SlimRow,
    | "f_unresolved"
    | "f_ambiguous"
    | "f_needs_gift"
    | "f_correction"
    | "f_refund"
    | "f_completed"
    | "f_not_fundraising"
  >,
): Lens[] {
  const out: Lens[] = [];
  const canonical = lensFlagsFromState(state);
  if (!canonical.completed && !flags.f_not_fundraising) out.push("all_open");
  if (flags.f_unresolved) out.push("unresolved_composition");
  if (flags.f_ambiguous) out.push("ambiguous_pairing");
  if (flags.f_needs_gift) out.push("needs_gift");
  if (flags.f_correction) out.push("accounting_corrections");
  if (canonical.refunds || flags.f_refund) out.push("refunds");
  if (canonical.completed) out.push("completed");
  if (flags.f_not_fundraising) out.push("not_fundraising");
  return out;
}

function buildUniverse(q: string | null) {
  const search = q
    ? `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
    : null;
  return sql`
    SELECT id, anchor_date,
      (f_unresolved AND NOT f_not_fundraising) AS f_unresolved,
      (f_ambiguous AND NOT f_not_fundraising) AS f_ambiguous,
      (f_needs_gift AND NOT f_not_fundraising) AS f_needs_gift,
      (f_correction AND NOT f_not_fundraising) AS f_correction,
      f_refund,
      (
        ${sql.raw(QB_DOCUMENTATION_COMPLETE_SQL)}
        AND NOT f_unresolved
        AND NOT f_ambiguous
        AND NOT f_needs_gift
        AND NOT f_correction
        AND NOT f_refund
        AND NOT f_not_fundraising
      ) AS f_completed,
      f_not_fundraising
    FROM (
      SELECT
        d.id,
        d.deposit_date AS anchor_date,
        (
          (
            p.id IS NULL AND (
              count(c.id) = 0 OR abs(COALESCE(sum(c.amount), 0) - d.amount) >= 0.005
            )
          ) OR (
            p.id IS NOT NULL AND p.net_total IS NOT NULL
            AND abs(p.net_total - d.amount) >= 0.005
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
              SELECT 1 FROM payment_units ppu
              WHERE ppu.stripe_charge_id = pc.id
                AND ppu.gift_id IS NOT NULL
            )
        )
        OR COALESCE(bool_or(c.id IS NOT NULL AND c.exclusion_reason IS NULL AND NOT EXISTS (
        SELECT 1 FROM payment_units pu
        WHERE pu.id = c.payment_unit_id
          AND pu.gift_id IS NOT NULL
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
        JOIN source_links pqs_c ON pqs_c.link_type = 'payout_qb_settlement'
          AND pqs_c.qb_staged_payment_id = pqc.staged_payment_id
        JOIN stripe_payouts psp_payout ON psp_payout.id = pqs_c.stripe_payout_id
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
            FROM source_links dqc_all
            WHERE dqc_all.link_type = 'qbo_line_deposit'
              AND dqc_all.bank_deposit_id = d.id
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
            FROM source_links dqc_open
            JOIN staged_payments sp_open ON sp_open.id = dqc_open.qb_staged_payment_id
            WHERE dqc_open.link_type = 'qbo_line_deposit'
              AND dqc_open.bank_deposit_id = d.id
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
                FROM source_links dqc
                JOIN staged_payments qsp ON qsp.id = dqc.qb_staged_payment_id
                WHERE dqc.link_type = 'qbo_line_deposit'
                  AND dqc.bank_deposit_id = d.id
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
                FROM source_links dqc
                JOIN staged_payments qsp ON qsp.id = dqc.qb_staged_payment_id
                WHERE dqc.link_type = 'qbo_line_deposit'
                  AND dqc.bank_deposit_id = d.id
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
        ${
          search === null
            ? sql`TRUE`
            : sql`(
          d.id ILIKE ${search} OR d.memo ILIKE ${search} OR d.reference ILIKE ${search}
          OR EXISTS (
            SELECT 1 FROM bank_deposit_components sqc
            JOIN payment_units squ ON squ.id = sqc.payment_unit_id
            LEFT JOIN gifts_and_payments sqg ON sqg.id = squ.gift_id
            LEFT JOIN staged_payments sqsp ON sqsp.id = squ.source_staged_payment_id
            LEFT JOIN organizations sqo ON sqo.id = sqg.organization_id
            LEFT JOIN people sqp ON sqp.id = sqg.individual_giver_person_id
            LEFT JOIN households sqh ON sqh.id = sqg.household_id
            WHERE sqc.bank_deposit_id = d.id
              AND (
                squ.id ILIKE ${search} OR sqg.name ILIKE ${search}
                OR sqsp.payer_name ILIKE ${search}
                OR sqsp.qb_transaction_memo ILIKE ${search}
                OR sqsp.line_description ILIKE ${search}
                OR sqo.name ILIKE ${search}
                OR (COALESCE(sqp.first_name, '') || ' ' || COALESCE(sqp.last_name, '')) ILIKE ${search}
                OR sqh.name ILIKE ${search}
              )
          )
          OR EXISTS (
            SELECT 1 FROM source_links sdqc
            JOIN staged_payments ssp ON ssp.id = sdqc.qb_staged_payment_id
            WHERE sdqc.link_type = 'qbo_line_deposit'
              AND sdqc.bank_deposit_id = d.id
              AND (
                ssp.payer_name ILIKE ${search}
                OR ssp.qb_transaction_memo ILIKE ${search}
                OR ssp.line_description ILIKE ${search}
              )
          )
          OR EXISTS (
            SELECT 1 FROM source_links sbqr
            JOIN bank_transactions sbt ON sbt.id = sbqr.bank_transaction_id
            WHERE sbqr.link_type = 'qbo_register_deposit'
              AND sbqr.bank_deposit_id = d.id
              AND (sbt.payee ILIKE ${search} OR sbt.memo ILIKE ${search})
          )
          OR EXISTS (
            SELECT 1 FROM stripe_payouts scp
            JOIN stripe_staged_charges sch ON sch.stripe_payout_id = scp.id
            WHERE scp.bank_deposit_id = d.id
              AND sch.payer_name ILIKE ${search}
          )
        )`
        }
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
    const lens: Lens = (LENSES as readonly string[]).includes(rawLens)
      ? (rawLens as Lens)
      : "all_open";
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
            FROM source_links dqc
            JOIN staged_payments qsp ON qsp.id = dqc.qb_staged_payment_id
            WHERE dqc.link_type = 'qbo_line_deposit'
              AND dqc.bank_deposit_id = d.id
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
            'manual', (c.source = 'manual'),
            'stagedPaymentId', u.source_staged_payment_id,
            'label', (
              SELECT COALESCE(lsp.payer_name, lsp.qb_transaction_memo, lsp.line_description)
              FROM staged_payments lsp WHERE lsp.id = u.source_staged_payment_id
            ),
            'receivedDate', u.received_date::text,
            'sourceStagedPaymentManual', (
              u.source_staged_payment_id IS NOT NULL
              AND c.source_staged_payment_id IS DISTINCT FROM u.source_staged_payment_id
            ),
            'exclusionReason', c.exclusion_reason,
            'countedGiftIds', CASE WHEN u.gift_id IS NULL THEN '[]'::jsonb
              ELSE jsonb_build_array(u.gift_id) END
          ) ORDER BY c.id)
          FROM bank_deposit_components c
          JOIN payment_units u ON u.id = c.payment_unit_id
          WHERE c.bank_deposit_id = d.id
        ), '[]'::jsonb) AS components,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'componentId', dqc.id, 'paymentUnitId', NULL,
            'amount', sp.amount::text,
            'kind', CASE
              WHEN (${inferredPaymentMethod("sp")}) ILIKE '%check%' THEN 'check'
              WHEN (${inferredPaymentMethod("sp")}) ILIKE '%wire%' THEN 'wire'
              WHEN (${inferredPaymentMethod("sp")}) ILIKE '%ach%' OR sp.funding_source = 'wire_ach' THEN 'direct_ach'
              ELSE 'other'
            END,
            'needsReview', dqc.match_basis = 'deposit_header_ambiguous',
            'ambiguousDepositMatch', dqc.match_basis = 'deposit_header_ambiguous',
            'unconfirmed', dqc.confirmed_at IS NULL, 'source', 'qbo_provisional',
            'manual', false,
            'stagedPaymentId', sp.id,
            'label', COALESCE(sp.payer_name, sp.qb_transaction_memo, sp.line_description, sp.raw_reference, sp.id),
            'exclusionReason', sp.exclusion_reason,
            'matchBasis', dqc.match_basis,
            'countedGiftIds', '[]'::jsonb
          ) ORDER BY dqc.id)
          FROM source_links dqc
          JOIN staged_payments sp ON sp.id = dqc.qb_staged_payment_id
          WHERE dqc.link_type = 'qbo_line_deposit'
            AND dqc.bank_deposit_id = d.id
            -- A staged payment already composed onto this deposit (a component's
            -- unit sources it) is real composition; its QBO deposit-line link is
            -- redundant evidence, not a second payment.
            AND NOT EXISTS (
              SELECT 1
              FROM bank_deposit_components pc
              JOIN payment_units pcu ON pcu.id = pc.payment_unit_id
              WHERE pc.bank_deposit_id = d.id
                AND pcu.source_staged_payment_id = sp.id
            )
        ), '[]'::jsonb) AS provisional_components,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'paymentUnitId', u.id, 'kind', u.kind, 'amount', COALESCE(u.gross_amount, u.net_amount)::text,
            'lifecycle', u.lifecycle, 'sourceStagedPaymentId', u.source_staged_payment_id,
            'countedGiftIds', CASE WHEN u.gift_id IS NULL THEN '[]'::jsonb
              ELSE jsonb_build_array(u.gift_id) END
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
            'allocations', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', ga.id, 'amount', ga.sub_amount::text,
                'usage', ga.display_usage,
                'purpose', COALESCE(ga.purpose_verbatim, ga.restriction_description)
              ) ORDER BY ga.id)
              FROM gift_allocations ga WHERE ga.gift_id = g.id
            ), '[]'::jsonb),
            'donorbox', false, 'grantLetter', false, 'codingForm', false,
            'recordComplete', (g.organization_id IS NOT NULL OR g.individual_giver_person_id IS NOT NULL OR g.household_id IS NOT NULL)
              AND EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id),
            'linkedChargeIds', COALESCE((
              SELECT jsonb_agg(pu2.stripe_charge_id)
              FROM payment_units pu2
              WHERE pu2.gift_id = g.id AND pu2.stripe_charge_id IS NOT NULL
            ), '[]'::jsonb),
            'linkedStagedPaymentIds', COALESCE((
              SELECT jsonb_agg(pu3.source_staged_payment_id)
              FROM payment_units pu3
              WHERE pu3.gift_id = g.id AND pu3.source_staged_payment_id IS NOT NULL
            ), '[]'::jsonb)
          ))
          FROM payment_units pa_u
          JOIN gifts_and_payments g ON g.id = pa_u.gift_id
          LEFT JOIN organizations o ON o.id = g.organization_id
          LEFT JOIN households h ON h.id = g.household_id
          LEFT JOIN people p2 ON p2.id = g.individual_giver_person_id
          WHERE pa_u.gift_id IS NOT NULL AND (
            pa_u.id IN (SELECT c2.payment_unit_id FROM bank_deposit_components c2 WHERE c2.bank_deposit_id = d.id)
            OR (
              pa_u.stripe_charge_id IN (
                SELECT ch2.id
                FROM stripe_staged_charges ch2
                WHERE ch2.stripe_payout_id = p.id
                  AND ch2.raw_charge->>'status' = 'succeeded'
              )
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
            'linkedGiftId', (SELECT pu.gift_id FROM payment_units pu
              WHERE pu.stripe_charge_id = ch.id AND pu.gift_id IS NOT NULL
              LIMIT 1),
            'paymentUnitId', (SELECT pu.id FROM payment_units pu
              WHERE pu.stripe_charge_id = ch.id LIMIT 1),
            'paymentUnitLifecycle', (SELECT pu.lifecycle::text FROM payment_units pu
              WHERE pu.stripe_charge_id = ch.id LIMIT 1),
            'refunded', ch.refunded, 'disputed', ch.disputed,
            'amountRefunded', ch.amount_refunded::text,
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
            SELECT DISTINCT ON ((item->>'stagedPaymentId')) item
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
            JOIN source_links pqs_r ON pqs_r.link_type = 'payout_qb_settlement'
              AND pqs_r.qb_staged_payment_id = psp.id
            JOIN stripe_payouts pp ON pp.id = pqs_r.stripe_payout_id
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
              'depositQboComponentId', dqc.id, 'unconfirmed', dqc.confirmed_at IS NULL,
              'source', 'qbo_provisional', 'matchBasis', dqc.match_basis
            ) AS item
            FROM source_links dqc
            JOIN staged_payments qsp ON qsp.id = dqc.qb_staged_payment_id
            WHERE dqc.link_type = 'qbo_line_deposit'
              AND dqc.bank_deposit_id = d.id
            UNION ALL
            SELECT jsonb_build_object(
              'stagedPaymentId', bt.id, 'role', 'deposit', 'reference', bt.ref_no,
              'lineDescription', bt.txn_type, 'memo', bt.memo,
              'amount', bt.deposit::text, 'dateReceived', bt.txn_date::text,
              'payerName', bt.payee, 'qbLocation', bt.account,
              'bankTransactionId', bt.id, 'payee', bt.payee,
              'txnType', bt.txn_type, 'refNo', bt.ref_no,
              'reconciliationStatus', bt.reconciliation_status,
              'account', bt.account
            ) AS item
            FROM source_links bqr
            JOIN bank_transactions bt ON bt.id = bqr.bank_transaction_id
            WHERE bqr.link_type = 'qbo_register_deposit'
              AND bqr.bank_deposit_id = d.id
            ) all_records
            ORDER BY (item->>'stagedPaymentId'), (item->>'source')
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
            JOIN source_links pqs_a ON pqs_a.link_type = 'payout_qb_settlement'
              AND pqs_a.qb_staged_payment_id = psp.id
            JOIN stripe_payouts pp ON pp.id = pqs_a.stripe_payout_id
            WHERE pp.bank_deposit_id = d.id
          ) checks
        ), '[]'::jsonb) AS accounting_checks
      FROM bank_deposits d
      LEFT JOIN stripe_payouts p ON p.bank_deposit_id = d.id
      LEFT JOIN bank_transactions bt ON bt.id = d.source_bank_transaction_id
      WHERE d.id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      GROUP BY d.id, p.id, bt.payee, bt.ref_no, bt.txn_type
    `);
    const byId = new Map(
      (rowResult.rows as unknown as DepositRow[]).map((r) => [r.id, r]),
    );
    await hydrateQboRollups(rowResult.rows as unknown as DepositRow[]);
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
      const state = stateForDeposit(s, r, gifts);
      const lenses = depositLenses(s, state, s);
      const liveTransactions = state.transactions.filter(
        (transaction) =>
          transaction.livePayment && transaction.state !== "excluded",
      );
      const coveredTransactions = liveTransactions.filter(
        (transaction) =>
          transaction.state === "matched" ||
          transaction.state === "refund_anticipated",
      );
      const uncoveredTransactions = liveTransactions.filter(
        (transaction) =>
          transaction.state !== "matched" &&
          transaction.state !== "refund_anticipated",
      );
      return [
        {
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
              : [...r.components, ...r.provisional_components]
                  .reduce((sum, c) => sum + amount(c.amount), 0)
                  .toFixed(2),
            unexplainedAmount: r.payout_id
              ? "0.00"
              : Math.max(
                  0,
                  amount(r.amount) -
                    [...r.components, ...r.provisional_components].reduce(
                      (sum, c) => sum + amount(c.amount),
                      0,
                    ),
                ).toFixed(2),
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
                grain: state.transactions.length ? "unit" : "none",
                complete: state.linkage.transactionToCrm.state === "complete",
                coveredIds: coveredTransactions.map(
                  (transaction) => transaction.transactionId,
                ),
                uncoveredIds: uncoveredTransactions.map(
                  (transaction) => transaction.transactionId,
                ),
                expectedAmount: r.amount,
                representedAmount: gifts
                  .reduce((sum, g) => sum + amount(g.amount), 0)
                  .toFixed(2),
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
                  satisfiedBy: g.recordComplete
                    ? "donor_and_allocations"
                    : null,
                  crmReason: g.recordComplete ? null : "missing_donor",
                  linkedChargeIds: g.linkedChargeIds,
                  linkedStagedPaymentIds: g.linkedStagedPaymentIds,
                })),
              ),
              complete:
                state.information.crmComplete &&
                state.linkage.transactionToCrm.state === "complete",
            },
            paymentTransaction: {
              grain: state.linkage.accountingToTransaction.grain,
              complete:
                state.linkage.accountingToTransaction.state === "complete",
              coveredIds: state.transactions.map(
                (transaction) => transaction.transactionId,
              ),
              uncoveredIds:
                state.linkage.accountingToTransaction.state === "complete"
                  ? []
                  : state.transactions.map(
                      (transaction) => transaction.transactionId,
                    ),
              expectedAmount: r.amount,
              representedAmount: r.amount,
              representationNote: null,
            },
            accountingEvidence: {
              grain:
                r.accounting_checks.length || r.qb_records.length
                  ? "bundle"
                  : "none",
              complete: state.information.qbEvidenceComplete,
              coveredIds: r.accounting_checks.map((c) =>
                String(c.stagedPaymentId),
              ),
              uncoveredIds: [],
              expectedAmount: r.amount,
              representedAmount: r.amount,
              representationNote: null,
            },
            complete: rowCompleteFromState(state),
            state,
          },
        },
      ];
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
    const params = parseOrBadRequest(
      SetBankDepositExclusionParams,
      req.params,
      res,
    );
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
    const params = parseOrBadRequest(
      ClearBankDepositExclusionParams,
      req.params,
      res,
    );
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
      .where(
        sql`${bankDepositExclusions.bankDepositId} = ${params.bankDepositId}`,
      );
    res.status(204).send();
  }),
);

router.patch(
  "/reconciliation/deposit-components/:id/source-staged-payment",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(
      SetBankDepositComponentSourceStagedPaymentParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(
      SetBankDepositComponentSourceStagedPaymentBody,
      req.body,
      res,
    );
    if (!body) return;

    const result = await db.transaction(async (tx) => {
      const componentResult = await tx.execute(sql`
        SELECT c.id, c.source, c.needs_review, c.payment_unit_id,
               u.id AS unit_id, u.kind, u.source_staged_payment_id
        FROM bank_deposit_components c
        JOIN payment_units u ON u.id = c.payment_unit_id
        WHERE c.id = ${params.id}
        FOR UPDATE OF c, u
      `);
      const component = (
        componentResult.rows as Array<{
          id: string;
          source: string;
          needs_review: boolean;
          payment_unit_id: string;
          unit_id: string;
          kind: string;
          source_staged_payment_id: string | null;
        }>
      )[0];
      if (!component) return { kind: "not_found" as const };
      if (!["check", "direct_ach", "wire", "other"].includes(component.kind)) {
        return { kind: "component_not_eligible" as const };
      }
      if (!body.stagedPaymentId) {
        await tx.execute(sql`
          UPDATE payment_units
          SET source_staged_payment_id = NULL, updated_at = now()
          WHERE id = ${component.payment_unit_id}
        `);
        return {
          kind: "ok" as const,
          componentId: component.id,
          paymentUnitId: component.payment_unit_id,
          sourceStagedPaymentId: null,
          needsReview: component.needs_review,
        };
      }

      const targetResult = await tx.execute(sql`
        SELECT
          sp.id,
          sp.exclusion_reason,
          EXISTS (
            SELECT 1
            FROM payment_units other
            WHERE other.source_staged_payment_id = sp.id
              AND other.id <> ${component.payment_unit_id}
          ) AS claimed_by_unit,
          EXISTS (
            SELECT 1
            FROM source_links sl
            WHERE sl.qb_staged_payment_id = sp.id
              AND sl.lifecycle IN ('proposed', 'confirmed')
          ) AS linked_in_source_links,
          EXISTS (
            SELECT 1
            FROM payment_units booked_unit
            WHERE booked_unit.source_staged_payment_id = sp.id
              AND booked_unit.gift_id IS NOT NULL
          ) AS counted_to_gift
        FROM staged_payments sp
        WHERE sp.id = ${body.stagedPaymentId}
        FOR SHARE
      `);
      const target = (
        targetResult.rows as Array<{
          id: string;
          exclusion_reason: string | null;
          claimed_by_unit: boolean;
          linked_in_source_links: boolean;
          counted_to_gift: boolean;
        }>
      )[0];
      if (
        !target ||
        target.exclusion_reason ||
        target.claimed_by_unit ||
        target.linked_in_source_links ||
        target.counted_to_gift
      ) {
        return { kind: "qbo_unavailable" as const };
      }

      const clearPlaceholderReview =
        component.unit_id.startsWith("pu_manual_") && component.needs_review;
      await tx.execute(sql`
        UPDATE payment_units
        SET source_staged_payment_id = ${body.stagedPaymentId}, updated_at = now()
        WHERE id = ${component.payment_unit_id}
      `);
      if (clearPlaceholderReview) {
        await tx.execute(sql`
          UPDATE bank_deposit_components
          SET needs_review = false, updated_at = now()
          WHERE id = ${component.id}
        `);
      }
      return {
        kind: "ok" as const,
        componentId: component.id,
        paymentUnitId: component.payment_unit_id,
        sourceStagedPaymentId: body.stagedPaymentId,
        needsReview: clearPlaceholderReview ? false : component.needs_review,
      };
    });

    if (result.kind === "not_found") {
      notFound(res, "bank deposit component");
      return;
    }
    if (result.kind === "component_not_eligible") {
      res.status(409).json({
        error: "component_not_eligible",
        message:
          "Only direct check, ACH, wire, and other components can use a source QBO pointer.",
      });
      return;
    }
    if (result.kind === "qbo_unavailable") {
      res.status(409).json({
        error: "qbo_staged_payment_unavailable",
        message:
          "That QBO record is already claimed, linked as evidence, counted to a gift, or excluded.",
      });
      return;
    }
    res.json({
      componentId: result.componentId,
      paymentUnitId: result.paymentUnitId,
      sourceStagedPaymentId: result.sourceStagedPaymentId,
      needsReview: result.needsReview,
    });
  }),
);

router.post(
  "/reconciliation/deposit-components/:id/exclude",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(
      ExcludeBankDepositComponentParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(
      ExcludeBankDepositComponentBody,
      req.body,
      res,
    );
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
    const params = parseOrBadRequest(
      ReIncludeBankDepositComponentParams,
      req.params,
      res,
    );
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

router.get(
  "/reconciliation/deposits/:bankDepositId/candidate-payment-units",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(
      ListDepositCandidatePaymentUnitsParams,
      req.params,
      res,
    );
    if (!params) return;
    const query = parseOrBadRequest(
      ListDepositCandidatePaymentUnitsQueryParams,
      req.query,
      res,
    );
    if (!query) return;

    const depositResult = await db.execute(sql`
      SELECT d.amount::text AS amount,
             COALESCE(SUM(c.amount), 0)::text AS component_total,
             COALESCE((
               SELECT SUM(dq_sp.amount)
               FROM source_links dqc
               JOIN staged_payments dq_sp ON dq_sp.id = dqc.qb_staged_payment_id
               WHERE dqc.link_type = 'qbo_line_deposit'
                 AND dqc.bank_deposit_id = d.id
                 AND NOT EXISTS (
                   SELECT 1
                   FROM bank_deposit_components pc
                   JOIN payment_units pcu ON pcu.id = pc.payment_unit_id
                   WHERE pc.bank_deposit_id = d.id
                     AND pcu.source_staged_payment_id = dq_sp.id
                 )
             ), 0)::text AS provisional_total,
             p.amount::text AS payout_amount
      FROM bank_deposits d
      LEFT JOIN stripe_payouts p ON p.bank_deposit_id = d.id
      LEFT JOIN bank_deposit_components c ON c.bank_deposit_id = d.id
      WHERE d.id = ${params.bankDepositId}
      GROUP BY d.id, p.amount
    `);
    const deposit = (
      depositResult.rows as Array<{
        amount: string;
        component_total: string;
        provisional_total: string;
        payout_amount: string | null;
      }>
    )[0];
    if (!deposit) {
      notFound(res, "bank deposit");
      return;
    }
    const remainder = Math.max(
      0,
      Number(deposit.amount) -
        Number(deposit.payout_amount ?? 0) -
        Number(deposit.component_total) -
        Number(deposit.provisional_total),
    );
    const targetAmount = query.amount ? Number(query.amount) : remainder;
    const amountBand = Math.max(0.01, targetAmount * 0.2);
    const search = query.q?.trim() || null;
    const result = await db.execute(sql`
      SELECT
        u.id,
        u.kind,
        COALESCE(u.gross_amount, u.net_amount)::text AS amount,
        u.currency,
        u.received_date::text AS received_date,
        COALESCE(
          sp.payer_name,
          sp.qb_transaction_memo,
          sp.line_description,
          sp.raw_reference,
          u.id
        ) AS source_label
      FROM payment_units u
      LEFT JOIN staged_payments sp ON sp.id = u.source_staged_payment_id
      WHERE u.kind IN ('check', 'direct_ach', 'wire', 'other')
        AND u.stripe_charge_id IS NULL
        AND COALESCE(u.gross_amount, u.net_amount) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM bank_deposit_components claimed
          WHERE claimed.payment_unit_id = u.id
        )
        AND abs(COALESCE(u.gross_amount, u.net_amount) - ${targetAmount}::numeric) <= ${amountBand}::numeric
        AND (
          ${search}::text IS NULL
          OR u.id ILIKE '%' || ${search} || '%'
          OR COALESCE(sp.payer_name, '') ILIKE '%' || ${search} || '%'
          OR COALESCE(sp.qb_transaction_memo, '') ILIKE '%' || ${search} || '%'
          OR COALESCE(sp.line_description, '') ILIKE '%' || ${search} || '%'
        )
      ORDER BY abs(COALESCE(u.gross_amount, u.net_amount) - ${targetAmount}::numeric),
               u.received_date DESC NULLS LAST,
               u.id
      LIMIT ${query.limit}
    `);
    res.json({
      data: (
        result.rows as Array<{
          id: string;
          kind: "check" | "direct_ach" | "wire" | "other";
          amount: string;
          currency: string;
          received_date: string | null;
          source_label: string;
        }>
      ).map((row) => ({
        id: row.id,
        kind: row.kind,
        amount: row.amount,
        currency: row.currency,
        receivedDate: row.received_date,
        sourceLabel: row.source_label,
      })),
    });
  }),
);

router.post(
  "/reconciliation/deposits/:bankDepositId/components",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(
      AddBankDepositComponentParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(AddBankDepositComponentBody, req.body, res);
    if (!body) return;
    const user = getAppUser(req);

    const result = await db.transaction(async (tx) => {
      const depositResult = await tx.execute(sql`
        SELECT d.amount::text AS amount, d.currency, d.deposit_date::text AS deposit_date,
               p.amount::text AS payout_amount,
               COALESCE(SUM(c.amount), 0)::text AS component_total,
               COALESCE((
                 SELECT SUM(dq_sp.amount)
                 FROM source_links dqc
                 JOIN staged_payments dq_sp ON dq_sp.id = dqc.qb_staged_payment_id
                 WHERE dqc.link_type = 'qbo_line_deposit'
                   AND dqc.bank_deposit_id = d.id
                   AND NOT EXISTS (
                     SELECT 1
                     FROM bank_deposit_components pc
                     JOIN payment_units pcu ON pcu.id = pc.payment_unit_id
                     WHERE pc.bank_deposit_id = d.id
                       AND pcu.source_staged_payment_id = dq_sp.id
                   )
               ), 0)::text AS provisional_total
        FROM bank_deposits d
        LEFT JOIN stripe_payouts p ON p.bank_deposit_id = d.id
        LEFT JOIN bank_deposit_components c ON c.bank_deposit_id = d.id
        WHERE d.id = ${params.bankDepositId}
        GROUP BY d.id, p.amount
      `);
      const deposit = (
        depositResult.rows as Array<{
          amount: string;
          currency: string;
          deposit_date: string;
          payout_amount: string | null;
          component_total: string;
          provisional_total: string;
        }>
      )[0];
      if (!deposit) return { kind: "not_found" as const };

      const amount =
        body.mode === "attach" || (body.mode === "gift" && body.amount == null)
          ? null
          : Number(body.amount);
      if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
        return { kind: "invalid_amount" as const };
      }
      const remainder = Math.max(
        0,
        Number(deposit.amount) -
          Number(deposit.payout_amount ?? 0) -
          Number(deposit.component_total) -
          Number(deposit.provisional_total),
      );

      let paymentUnitId: string;
      let componentAmount: number;
      let needsReview = false;
      if (body.mode === "attach") {
        const unitResult = await tx.execute(sql`
          SELECT id, kind, stripe_charge_id,
                 COALESCE(gross_amount, net_amount)::text AS amount
          FROM payment_units
          WHERE id = ${body.paymentUnitId}
          FOR UPDATE
        `);
        const unit = (
          unitResult.rows as Array<{
            id: string;
            kind: "check" | "direct_ach" | "wire" | "other";
            stripe_charge_id: string | null;
            amount: string | null;
          }>
        )[0];
        if (
          !unit ||
          unit.stripe_charge_id ||
          !["check", "direct_ach", "wire", "other"].includes(unit.kind)
        ) {
          return { kind: "unit_unavailable" as const };
        }
        const claimed = await tx.execute(sql`
          SELECT 1
          FROM bank_deposit_components
          WHERE payment_unit_id = ${body.paymentUnitId}
          LIMIT 1
        `);
        if (claimed.rows.length) return { kind: "unit_unavailable" as const };
        paymentUnitId = unit.id;
        componentAmount =
          body.amount == null ? Number(unit.amount ?? 0) : Number(body.amount);
        if (!Number.isFinite(componentAmount) || componentAmount <= 0) {
          return { kind: "invalid_amount" as const };
        }
      } else if (body.mode === "gift") {
        const giftResult = await tx.execute(sql`
          SELECT id FROM gifts_and_payments WHERE id = ${body.giftId}
        `);
        if (!giftResult.rows.length) return { kind: "gift_not_found" as const };

        // A deposit recorded as a gift-less single payment ("Record without a
        // gift") already carries the whole-amount unit+component — linking a
        // gift then means pointing THAT unit at the gift, not composing a
        // second component (the remainder is already zero).
        const adoptableResult = await tx.execute(sql`
          SELECT u.id, c.id AS component_id, c.amount::text AS component_amount,
                 c.needs_review
          FROM bank_deposit_components c
          JOIN payment_units u ON u.id = c.payment_unit_id
          WHERE c.bank_deposit_id = ${params.bankDepositId}
            AND u.gift_id IS NULL
            AND u.stripe_charge_id IS NULL
            AND u.kind IN ('check', 'direct_ach', 'wire', 'other')
          ORDER BY u.id
          FOR UPDATE OF u
        `);
        const adoptable = adoptableResult.rows as Array<{
          id: string;
          component_id: string;
          component_amount: string;
          needs_review: boolean;
        }>;
        const adoptMatches =
          amount == null
            ? adoptable
            : adoptable.filter(
                (a) => Math.abs(Number(a.component_amount) - amount) <= 0.005,
              );
        if (adoptMatches.length === 1) {
          const adopted = adoptMatches[0];
          await tx.execute(sql`
            UPDATE payment_units
            SET gift_id = ${body.giftId},
                gift_match_method = 'human',
                gift_confirmed_by_user_id = ${user?.id ?? null},
                gift_confirmed_at = now()
            WHERE id = ${adopted.id}
          `);
          return {
            kind: "ok" as const,
            id: adopted.component_id,
            paymentUnitId: adopted.id,
            amount: Number(adopted.component_amount).toFixed(2),
            needsReview: adopted.needs_review,
          };
        }
        if (adoptMatches.length > 1) {
          return { kind: "deposit_units_ambiguous" as const };
        }

        const candidatesResult = await tx.execute(sql`
          SELECT u.id, COALESCE(u.gross_amount, u.net_amount)::text AS amount
          FROM payment_units u
          WHERE u.gift_id = ${body.giftId}
            AND u.kind IN ('check', 'direct_ach', 'wire', 'other')
            AND u.stripe_charge_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM bank_deposit_components claimed
              WHERE claimed.payment_unit_id = u.id
            )
          ORDER BY u.id
          FOR UPDATE OF u
        `);
        const candidates = candidatesResult.rows as Array<{
          id: string;
          amount: string | null;
        }>;
        const target = amount ?? remainder;
        const exact = candidates.filter(
          (c) =>
            c.amount != null && Math.abs(Number(c.amount) - target) <= 0.005,
        );
        const pool = exact.length === 1 ? exact : candidates;
        if (pool.length > 1) return { kind: "gift_units_ambiguous" as const };
        if (pool.length === 1) {
          const unit = pool[0];
          paymentUnitId = unit.id;
          componentAmount =
            amount ?? (unit.amount != null ? Number(unit.amount) : remainder);
        } else {
          paymentUnitId = `pu_manual_${newId()}`;
          componentAmount = amount ?? remainder;
          if (!Number.isFinite(componentAmount) || componentAmount <= 0) {
            return { kind: "invalid_amount" as const };
          }
          await tx.execute(sql`
            INSERT INTO payment_units
              (id, kind, gross_amount, fee_amount, net_amount, currency,
               received_date, lifecycle, gift_id, gift_match_method,
               gift_confirmed_by_user_id, gift_confirmed_at)
            VALUES (
              ${paymentUnitId},
              'other',
              ${componentAmount}::numeric,
              0,
              ${componentAmount}::numeric,
              ${deposit.currency},
              ${deposit.deposit_date},
              'received',
              ${body.giftId},
              'human',
              ${user?.id ?? null},
              now()
            )
          `);
        }
        if (!Number.isFinite(componentAmount) || componentAmount <= 0) {
          return { kind: "invalid_amount" as const };
        }
      } else {
        paymentUnitId = `pu_manual_${newId()}`;
        componentAmount = amount ?? 0;
        needsReview = body.mode === "placeholder";
        if (componentAmount > remainder + 0.005) {
          return { kind: "amount_exceeds_remainder" as const };
        }
        await tx.execute(sql`
          INSERT INTO payment_units
            (id, kind, gross_amount, fee_amount, net_amount, currency, received_date, lifecycle)
          VALUES (
            ${paymentUnitId},
            ${body.mode === "placeholder" ? "other" : body.kind},
            ${componentAmount}::numeric,
            0,
            ${componentAmount}::numeric,
            ${deposit.currency},
            ${body.mode === "create" && body.receivedDate ? body.receivedDate : deposit.deposit_date},
            'received'
          )
        `);
      }
      if (componentAmount > remainder + 0.005) {
        return { kind: "amount_exceeds_remainder" as const };
      }
      const componentId = `bdc_${newId()}`;
      await tx.execute(sql`
        INSERT INTO bank_deposit_components
          (id, bank_deposit_id, payment_unit_id, amount, source, needs_review)
        VALUES (
          ${componentId},
          ${params.bankDepositId},
          ${paymentUnitId},
          ${componentAmount}::numeric,
          'manual',
          ${needsReview}
        )
      `);
      return {
        kind: "ok" as const,
        id: componentId,
        paymentUnitId,
        amount: componentAmount.toFixed(2),
        needsReview,
      };
    });

    if (result.kind === "not_found") {
      notFound(res, "bank deposit");
      return;
    }
    if (result.kind === "invalid_amount") {
      res.status(400).json({
        error: "invalid_amount",
        message: "Amount must be greater than zero.",
      });
      return;
    }
    if (result.kind === "unit_unavailable") {
      res.status(409).json({
        error: "payment_unit_unavailable",
        message:
          "That payment unit is already claimed or is not a direct payment.",
      });
      return;
    }
    if (result.kind === "gift_not_found") {
      notFound(res, "gift");
      return;
    }
    if (result.kind === "deposit_units_ambiguous") {
      res.status(409).json({
        error: "deposit_units_ambiguous",
        message:
          "This deposit has several gift-less payments — pass the exact payment amount to pick which one pays this gift.",
      });
      return;
    }
    if (result.kind === "gift_units_ambiguous") {
      res.status(409).json({
        error: "gift_units_ambiguous",
        message:
          "That gift has several unclaimed payment units — use Add known payment to pick the exact one.",
      });
      return;
    }
    if (result.kind === "amount_exceeds_remainder") {
      res.status(409).json({
        error: "amount_exceeds_remainder",
        message:
          "The component amount exceeds this deposit's unexplained remainder.",
      });
      return;
    }
    res.status(201).json({
      id: result.id,
      paymentUnitId: result.paymentUnitId,
      amount: result.amount,
      source: "manual",
      needsReview: result.needsReview,
    });
  }),
);

router.post(
  "/reconciliation/deposits/:bankDepositId/qbo-evidence",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(
      AttachDepositQboEvidenceParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(AttachDepositQboEvidenceBody, req.body, res);
    if (!body) return;
    const user = getAppUser(req);

    const deposit = await db
      .select({ id: bankDeposits.id })
      .from(bankDeposits)
      .where(eq(bankDeposits.id, params.bankDepositId))
      .then((r) => r[0]);
    if (!deposit) return notFound(res, "bank deposit");
    const staged = await db.execute(sql`
      SELECT id FROM staged_payments WHERE id = ${body.stagedPaymentId}
    `);
    if (!staged.rows.length) return notFound(res, "staged payment");

    const linkId = sourceLinkId("qbo_line_deposit", body.stagedPaymentId);
    const inserted = await db
      .insert(sourceLinks)
      .values({
        id: linkId,
        linkType: "qbo_line_deposit",
        qbStagedPaymentId: body.stagedPaymentId,
        bankDepositId: params.bankDepositId,
        matchBasis: "human",
        lifecycle: "confirmed",
        provenance: "human",
        confirmedByUserId: user?.id ?? null,
        confirmedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: sourceLinks.id });
    if (!inserted.length) {
      res.status(409).json({
        error: "already_claimed",
        message:
          "That QuickBooks record is already claimed as deposit evidence.",
      });
      return;
    }
    res.status(201).json({
      sourceLinkId: linkId,
      stagedPaymentId: body.stagedPaymentId,
      bankDepositId: params.bankDepositId,
    });
  }),
);

router.post(
  "/reconciliation/accounting-checks/flag",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const body = parseOrBadRequest(FlagQboAccountingErrorBody, req.body, res);
    if (!body) return;
    const user = getAppUser(req);

    const staged = await db.execute(sql`
      SELECT id FROM staged_payments WHERE id = ${body.stagedPaymentId}
    `);
    if (!staged.rows.length) return notFound(res, "staged payment");

    const checkId = `qac_${body.stagedPaymentId}`;
    await db
      .insert(qboAccountingChecks)
      .values({
        id: checkId,
        stagedPaymentId: body.stagedPaymentId,
        disposition: "correction_needed",
        note: body.note,
        resolvedByUserId: user?.id ?? null,
        resolvedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: qboAccountingChecks.stagedPaymentId,
        set: {
          disposition: "correction_needed",
          note: body.note,
          resolvedByUserId: user?.id ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    res.json({
      id: checkId,
      stagedPaymentId: body.stagedPaymentId,
      disposition: "correction_needed",
    });
  }),
);

router.delete(
  "/reconciliation/deposit-components/:id",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const params = parseOrBadRequest(
      RemoveManualBankDepositComponentParams,
      req.params,
      res,
    );
    if (!params) return;
    const result = await db.transaction(async (tx) => {
      const componentResult = await tx.execute(sql`
        SELECT c.id, c.source, c.payment_unit_id,
               u.id AS unit_id, u.id LIKE 'pu_manual_%' AS minted,
               u.gift_id IS NOT NULL AS has_counted_application
        FROM bank_deposit_components c
        JOIN payment_units u ON u.id = c.payment_unit_id
        WHERE c.id = ${params.id}
        FOR UPDATE OF c, u
      `);
      const component = (
        componentResult.rows as Array<{
          id: string;
          source: string;
          payment_unit_id: string;
          unit_id: string;
          minted: boolean;
          has_counted_application: boolean;
        }>
      )[0];
      if (!component) return { kind: "not_found" as const };
      if (
        !["manual", "qbo_inferred"].includes(component.source) ||
        component.has_counted_application
      ) {
        return { kind: "not_removable" as const };
      }
      await tx.execute(sql`
        DELETE FROM bank_deposit_components WHERE id = ${params.id}
      `);
      if (component.minted) {
        const hasApplications = await tx.execute(sql`
          SELECT 1 FROM payment_units
          WHERE id = ${component.payment_unit_id}
            AND gift_id IS NOT NULL
          UNION ALL
          SELECT 1 FROM source_links
          WHERE payment_unit_id = ${component.payment_unit_id}
          LIMIT 1
        `);
        if (!hasApplications.rows.length) {
          await tx.execute(sql`
            DELETE FROM payment_units
            WHERE id = ${component.payment_unit_id}
              AND id LIKE 'pu_manual_%'
          `);
        }
      }
      return { kind: "ok" as const };
    });
    if (result.kind === "not_found") {
      notFound(res, "bank deposit component");
      return;
    }
    if (result.kind === "not_removable") {
      res.status(409).json({
        error: "component_not_removable",
        message:
          "Only manual or QBO-inferred components without a counted gift can be removed.",
      });
      return;
    }
    res.status(204).send();
  }),
);

router.post(
  "/reconciliation/accounting-checks/:id/disposition",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = parseOrBadRequest(
      SetQboAccountingCheckDispositionBody,
      req.body,
      res,
    );
    if (!body) return;
    const checkId = req.params.id as string;
    if (body.disposition === "accepted_historical" && !body.note?.trim()) {
      res.status(400).json({
        error: "note_required",
        message: "A note is required when accepting historical accounting.",
      });
      return;
    }

    const [current] = await db
      .select({
        id: qboAccountingChecks.id,
        disposition: qboAccountingChecks.disposition,
      })
      .from(qboAccountingChecks)
      .where(eq(qboAccountingChecks.id, checkId))
      .limit(1);
    if (!current) {
      notFound(res, "accounting check");
      return;
    }
    if (current.disposition === "consistent") {
      res.status(409).json({
        error: "comparer_owned",
        message:
          "Consistent accounting checks are not eligible for human disposition.",
      });
      return;
    }

    const [row] = await db
      .update(qboAccountingChecks)
      .set({
        disposition: body.disposition,
        note: body.note?.trim() ?? null,
        resolvedByUserId: user.id,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(qboAccountingChecks.id, checkId))
      .returning({
        id: qboAccountingChecks.id,
        disposition: qboAccountingChecks.disposition,
        note: qboAccountingChecks.note,
        resolvedByUserId: qboAccountingChecks.resolvedByUserId,
        resolvedAt: qboAccountingChecks.resolvedAt,
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
      UPDATE source_links
      SET confirmed_by_user_id = ${user.id},
          confirmed_at = now(),
          updated_at = now()
      WHERE id = ${req.params.id}
        AND link_type = 'qbo_line_deposit'
      RETURNING id, (confirmed_at IS NOT NULL) AS confirmed
    `);
    const row = (result.rows as Array<{ id: string; confirmed: boolean }>)[0];
    if (!row) {
      res.status(404).json({
        error: "not_found",
        message: "Provisional QBO component not found.",
      });
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
      DELETE FROM source_links
      WHERE id = ${req.params.id}
        AND link_type = 'qbo_line_deposit'
      RETURNING id
    `);
    if (!result.rows.length) {
      res.status(404).json({
        error: "not_found",
        message: "Provisional QBO component not found.",
      });
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
    const deposit = (
      depositResult.rows as Array<{
        id: string;
        amount: string;
        currency: string;
        deposit_date: string;
      }>
    )[0];
    if (!deposit) {
      res
        .status(404)
        .json({ error: "not_found", message: "Bank deposit not found." });
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
      data: (
        result.rows as Array<{
          payout_id: string;
          arrival_date: string;
          amount: string;
          currency: string;
          current_bank_deposit_id: string | null;
          current_deposit_date: string | null;
          ambiguous: boolean;
        }>
      ).map((row) => ({
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
    const payout = (
      payoutResult.rows as Array<{
        id: string;
        amount: string;
        currency: string;
        arrival_date: string | null;
      }>
    )[0];
    if (!payout) {
      res
        .status(404)
        .json({ error: "not_found", message: "Stripe payout not found." });
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
      data: (
        result.rows as Array<{
          bank_deposit_id: string;
          deposit_date: string;
          amount: string;
          currency: string;
          memo: string | null;
          claimed: boolean;
          ambiguous: boolean;
        }>
      ).map((row) => ({
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
    const depositId =
      typeof req.body?.bankDepositId === "string" ? req.body.bankDepositId : "";
    const payoutResult = await db.execute(sql`
      SELECT id, amount::text AS amount, currency
      FROM stripe_payouts
      WHERE id = ${payoutId}
    `);
    const payout = (
      payoutResult.rows as Array<{
        id: string;
        amount: string | null;
        currency: string | null;
      }>
    )[0];
    if (!payout) {
      res
        .status(404)
        .json({ error: "not_found", message: "Stripe payout not found." });
      return;
    }
    const depositResult = await db.execute(sql`
      SELECT id, amount::text AS amount, currency
      FROM bank_deposits
      WHERE id = ${depositId}
    `);
    const deposit = (
      depositResult.rows as Array<{
        id: string;
        amount: string;
        currency: string;
      }>
    )[0];
    if (!deposit) {
      res
        .status(404)
        .json({ error: "not_found", message: "Bank deposit not found." });
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
    if (
      (occupiedResult.rows[0] as { occupied: boolean } | undefined)?.occupied
    ) {
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
      res
        .status(404)
        .json({ error: "not_found", message: "Stripe payout not found." });
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
      res.status(404).json({
        error: "not_found",
        message: "No payout is linked to this deposit.",
      });
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
        message:
          "Stripe payout not found or is not currently linked to a bank deposit.",
      });
      return;
    }
    res.json({ payoutId: req.params.payoutId });
  }),
);

export default router;
