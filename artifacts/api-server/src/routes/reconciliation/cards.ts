import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  settlementLinks,
  stagedPayments,
  stagedPaymentExclusionReasonEnum,
  stripePayouts,
  stripeStagedCharges,
} from "@workspace/db/schema";
import {
  and,
  asc,
  eq,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { opportunitiesAndPledges } from "@workspace/db/schema";
import {
  qbLedgerExistsForGiftExcludingPayment,
  chargeIdOwningGiftExcludingCharge,
} from "../../lib/paymentApplications";
import { stripeChargeActiveGiftIdSql } from "../../lib/stripeChargeLedger";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getViewer } from "../../lib/identityVisibility";
import { buildReconciliationGraph } from "../../lib/reconciliationGraph";
import {
  giftMatchAmountBounds,
  giftMatchAmountBoundsKnownNet,
  GIFT_MATCH_WINDOW_DAYS,
} from "../../lib/giftMatch";
import { deriveEvidenceLanes } from "../../lib/reconciliationLanes";
import {
  chargeStatusSql,
  stagedStatusWhere,
} from "../../lib/derivedStatus";
import { isQbGroupMemberSql } from "../../lib/unitGroupMembership";
import { payoutStatusLabelSql } from "../../lib/settlementLink";
import {
  entityWhere,
  isParkedFiscallyRow,
  queueWhere,
  resolvedGift,
  stagedOrderBy,
  stagedSearchWhere,
  stagedSelect,
  withJoins,
  type Queue,
} from "../quickbooks/shared";

const router: IRouter = Router();
const recCardOpp = alias(opportunitiesAndPledges, "rec_card_opp");
const READY_GIFT_DATE_WINDOW_DAYS = GIFT_MATCH_WINDOW_DAYS;
const activeChargeGiftId = stripeChargeActiveGiftIdSql(
  sql`${stripeStagedCharges.id}`,
);

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function unlinkedDonorGiftWhere(band: "proposal" | "strict" = "proposal"): SQL {
  return sql`(
    (${stagedPayments.organizationId} IS NOT NULL AND g.organization_id = ${stagedPayments.organizationId})
    OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
    OR (${stagedPayments.householdId} IS NOT NULL AND g.household_id = ${stagedPayments.householdId})
  )
  AND ${stagedPayments.amount} IS NOT NULL
  AND ${giftMatchAmountBounds(
    sql.raw("g.amount"),
    sql`${stagedPayments.amount}::numeric`,
    band === "proposal",
  )}
  AND g.archived_at IS NULL
  AND ${stagedPayments.dateReceived} IS NOT NULL
  AND g.date_received IS NOT NULL
  AND ABS(g.date_received - ${stagedPayments.dateReceived}) <= ${READY_GIFT_DATE_WINDOW_DAYS}
  AND NOT ${qbLedgerExistsForGiftExcludingPayment(
    sql.raw("g.id"),
    sql.raw('"staged_payments"."id"'),
  )}`;
}

const autoGiftCountExpr = sql<number>`(
  SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere()}
)`;

const autoGiftPickExpr = sql<{
  id: string;
  name: string | null;
  dateReceived: string | null;
} | null>`(
  SELECT jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'dateReceived', g.date_received::text
  )
  FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere()}
  ORDER BY ABS(g.amount - ${stagedPayments.amount}::numeric) ASC
  LIMIT 1
)`;

const readyExpr = sql<boolean>`(
  ${stagedStatusWhere.pending}
  AND ${stagedPayments.matchStatus} = 'matched'
  AND num_nonnulls(${stagedPayments.organizationId}, ${stagedPayments.individualGiverPersonId}, ${stagedPayments.householdId}) = 1
  AND (SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedDonorGiftWhere("strict")}) = 1
)`;

function unlinkedChargeGiftWhere(): SQL {
  return sql`(
    (${stripeStagedCharges.organizationId} IS NOT NULL AND g.organization_id = ${stripeStagedCharges.organizationId})
    OR (${stripeStagedCharges.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stripeStagedCharges.individualGiverPersonId})
    OR (${stripeStagedCharges.householdId} IS NOT NULL AND g.household_id = ${stripeStagedCharges.householdId})
  )
  AND ${stripeStagedCharges.grossAmount} IS NOT NULL
  AND ${stripeStagedCharges.netAmount} IS NOT NULL
  AND ${giftMatchAmountBoundsKnownNet(
    sql.raw("g.amount"),
    sql`${stripeStagedCharges.grossAmount}`,
    sql`${stripeStagedCharges.netAmount}`,
  )}
  AND g.archived_at IS NULL
  AND ${stripeStagedCharges.dateReceived} IS NOT NULL
  AND g.date_received IS NOT NULL
  AND ABS(g.date_received - ${stripeStagedCharges.dateReceived}) <= ${GIFT_MATCH_WINDOW_DAYS}
  AND ${chargeIdOwningGiftExcludingCharge(
    sql.raw("g.id"),
    sql`${stripeStagedCharges.id}`,
  )} IS NULL`;
}

const stripeEvidenceExpr = sql<{
  payoutId: string;
  chargeCount: number;
  reconciliationStatus: string | null;
  charge: {
    grossAmount: string | null;
    netAmount: string | null;
    feeAmount: string | null;
    payerName: string | null;
  } | null;
} | null>`(
  SELECT jsonb_build_object(
    'payoutId', p.id,
    'chargeCount', (
      SELECT COUNT(*)::int FROM stripe_staged_charges c WHERE c.stripe_payout_id = p.id
    ),
    'reconciliationStatus', ${payoutStatusLabelSql},
    'charge', (
      SELECT CASE WHEN COUNT(*) = 1 THEN jsonb_build_object(
        'grossAmount', MIN(c.gross_amount)::text,
        'netAmount', MIN(c.net_amount)::text,
        'feeAmount', MIN(c.fee_amount)::text,
        'payerName', MIN(c.payer_name)
      ) ELSE NULL END
      FROM stripe_staged_charges c WHERE c.stripe_payout_id = p.id
    )
  )
  FROM stripe_payouts p
  JOIN settlement_links sl ON sl.payout_id = p.id
  WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
  ORDER BY CASE WHEN sl.lifecycle = 'confirmed' THEN 0 ELSE 1 END,
           sl.updated_at DESC,
           sl.id
  LIMIT 1
)`;

const groupRepresentativeWhere: SQL = sql`(
  NOT ${isQbGroupMemberSql()}
  OR ${stagedPayments.id} = (
    SELECT MIN(m2.source_id COLLATE "C")
    FROM unit_group_members m1
    JOIN unit_group_members m2
      ON m2.group_id = m1.group_id AND m2.evidence_source = 'quickbooks'
    WHERE m1.evidence_source = 'quickbooks'
      AND m1.source_id = ${stagedPayments.id}
  )
)`;

const sourceGroupAggExpr = sql<{
  count: number;
  totalAmount: string;
  commonFundingSource: string | null;
  commonProvenance: string | null;
  members: Array<{
    stagedPaymentId: string;
    amount: string | null;
    dateReceived: string | null;
    payerName: string | null;
    qbDocNumber: string | null;
    fundingSource: string | null;
  }>;
} | null>`(
  CASE
    WHEN NOT ${isQbGroupMemberSql()} THEN NULL
    ELSE (
      SELECT jsonb_build_object(
        'count', COUNT(*)::int,
        'totalAmount', COALESCE(SUM(m.amount), 0)::text,
        'commonFundingSource',
          CASE WHEN COUNT(*) = COUNT(m.funding_source)
                AND COUNT(DISTINCT m.funding_source) = 1
               THEN MIN(m.funding_source) ELSE NULL END,
        'commonProvenance',
          CASE WHEN COUNT(DISTINCT m.funding_source_provenance) = 1
               THEN MIN(m.funding_source_provenance) ELSE NULL END,
        'members', COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'stagedPaymentId', m.id,
              'amount', m.amount::text,
              'dateReceived', m.date_received::text,
              'payerName', m.payer_name,
              'qbDocNumber', m.qb_doc_number,
              'fundingSource', m.funding_source
            ) ORDER BY m.id COLLATE "C"
          ),
          '[]'::jsonb
        )
      )
      FROM staged_payments m
      JOIN unit_group_members mem
        ON mem.source_id = m.id AND mem.evidence_source = 'quickbooks'
      WHERE mem.group_id = (
        SELECT g.group_id FROM unit_group_members g
        WHERE g.evidence_source = 'quickbooks'
          AND g.source_id = ${stagedPayments.id}
        LIMIT 1
      )
    )
  END
)`;

function reconciliationQueueWhere(queue: string | undefined): SQL | undefined {
  if (!queue || queue === "all") {
    return sql`(
      (
        ${stagedStatusWhere.pending}
        AND (${stagedPayments.entityId} IS NULL OR NOT (${isParkedFiscallyRow}))
      )
      OR (
        ${stagedPayments.exclusionReason} IS NULL
        AND ${stagedPayments.createdGiftId} IS NULL
        AND (
          ${stagedPayments.matchedGiftId} IS NOT NULL
          OR ${stagedPayments.groupReconciledGiftId} IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM payment_applications pa
            WHERE pa.payment_id = ${stagedPayments.id}
              AND pa.evidence_source = 'quickbooks'
              AND pa.link_role = 'counted'
              AND pa.lifecycle = 'confirmed'
          )
        )
        AND EXISTS (
          SELECT 1 FROM settlement_links sl
          WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
        )
      )
      OR (
        ${stagedStatusWhere.match_confirmed}
        AND ${stagedPayments.matchedGiftId} IS NULL
        AND ${stagedPayments.createdGiftId} IS NULL
        AND ${stagedPayments.groupReconciledGiftId} IS NULL
        AND EXISTS (
          SELECT 1
          FROM settlement_links sl
          JOIN stripe_staged_charges c ON c.stripe_payout_id = sl.payout_id
          WHERE sl.deposit_staged_payment_id = ${stagedPayments.id}
            AND c.exclusion_reason IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM payment_applications pa
              WHERE pa.stripe_charge_id = c.id
                AND pa.evidence_source = 'stripe'
                AND pa.link_role = 'counted'
                AND pa.lifecycle IN ('proposed', 'confirmed')
            )
        )
      )
    )`;
  }
  return queueWhere(queue as Queue);
}

router.get(
  "/reconciliation/cards",
  asyncHandler(async (req, res) => {
    const queue =
      typeof req.query["queue"] === "string" ? req.query["queue"] : undefined;
    const search =
      typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
    const entityId =
      typeof req.query["entityId"] === "string"
        ? req.query["entityId"]
        : undefined;
    const ready =
      req.query["ready"] === "true"
        ? true
        : req.query["ready"] === "false"
          ? false
          : undefined;
    const reasonValues =
      stagedPaymentExclusionReasonEnum.enumValues as readonly string[];
    const rawReason = req.query["exclusionReason"];
    const exclusionReason =
      typeof rawReason === "string" && reasonValues.includes(rawReason)
        ? (rawReason as (typeof stagedPaymentExclusionReasonEnum.enumValues)[number])
        : undefined;
    const limit = clampInt(req.query["limit"], 50, 1, 500);
    const offset = clampInt(req.query["offset"], 0, 0, 1_000_000);
    const rawFundingSource = req.query["fundingSource"];
    const fundingSource =
      rawFundingSource === "stripe" ||
      rawFundingSource === "donorbox" ||
      rawFundingSource === "qb_direct"
        ? rawFundingSource
        : undefined;
    const shouldExpand =
      queue === undefined || queue === "all" || queue === "needs_review";

    const conds: SQL[] = [];
    const queueCond = reconciliationQueueWhere(queue);
    if (queueCond) conds.push(queueCond);
    if (exclusionReason && queue === "excluded") {
      conds.push(eq(stagedPayments.exclusionReason, exclusionReason));
    }
    if (entityId) {
      const entityCond = entityWhere(entityId);
      if (entityCond) conds.push(entityCond);
    }
    if (search.length >= 1) {
      const searchCond = stagedSearchWhere(search);
      if (searchCond) conds.push(searchCond);
    }
    if (ready === true) conds.push(readyExpr);
    else if (ready === false) conds.push(sql`NOT ${readyExpr}`);

    if (fundingSource === "stripe") {
      conds.push(eq(stagedPayments.fundingSource, "stripe"));
    } else if (fundingSource === "donorbox") {
      conds.push(eq(stagedPayments.fundingSource, "donorbox"));
    } else if (fundingSource === "qb_direct") {
      const fundingCond = or(
        isNull(stagedPayments.fundingSource),
        notInArray(stagedPayments.fundingSource, ["stripe", "donorbox"]),
      );
      if (fundingCond) conds.push(fundingCond);
    }
    conds.push(groupRepresentativeWhere);

    const chargeSub = db
      .select({
        chargeId: sql<string>`"stripe_staged_charges"."id"`.as("charge_id"),
        payoutId: sql<string>`"stripe_payouts"."id"`.as("charge_payout_id"),
        grossAmount:
          sql<string | null>`${stripeStagedCharges.grossAmount}::text`.as(
            "charge_gross",
          ),
        netAmount:
          sql<string | null>`${stripeStagedCharges.netAmount}::text`.as(
            "charge_net",
          ),
        feeAmount:
          sql<string | null>`${stripeStagedCharges.feeAmount}::text`.as(
            "charge_fee",
          ),
        chargeStatus: chargeStatusSql.as("charge_status"),
        matchStatus: stripeStagedCharges.matchStatus,
        matchConfirmedAt: stripeStagedCharges.matchConfirmedAt,
        organizationId: stripeStagedCharges.organizationId,
        individualGiverPersonId: stripeStagedCharges.individualGiverPersonId,
        householdId: stripeStagedCharges.householdId,
        payerName: stripeStagedCharges.payerName,
        donorName: sql<string | null>`COALESCE(
          (SELECT o.name FROM organizations o WHERE o.id = ${stripeStagedCharges.organizationId}),
          (SELECT h.name FROM households h WHERE h.id = ${stripeStagedCharges.householdId}),
          (SELECT COALESCE(
                    NULLIF(TRIM(pp.full_name), ''),
                    NULLIF(TRIM(CONCAT_WS(' ', pp.first_name, pp.last_name)), '')
                  )
             FROM people pp WHERE pp.id = ${stripeStagedCharges.individualGiverPersonId})
        )`.as("charge_donor_name"),
        resolvedGiftId: activeChargeGiftId.as("charge_resolved_gift_id"),
        resolvedGiftName: sql<string | null>`(
          SELECT g.name FROM gifts_and_payments g
          WHERE g.id = ${activeChargeGiftId}
        )`.as("charge_resolved_gift_name"),
        resolvedGiftDonorName: sql<string | null>`(
          SELECT COALESCE(
            (SELECT o.name FROM organizations o WHERE o.id = g.organization_id),
            (SELECT h.name FROM households h WHERE h.id = g.household_id),
            (SELECT COALESCE(
                      NULLIF(TRIM(pp.full_name), ''),
                      NULLIF(TRIM(CONCAT_WS(' ', pp.first_name, pp.last_name)), '')
                    )
               FROM people pp WHERE pp.id = g.individual_giver_person_id)
          )
          FROM gifts_and_payments g
          WHERE g.id = ${activeChargeGiftId}
        )`.as("charge_resolved_gift_donor_name"),
        resolvedGiftAmount: sql<string | null>`(
          SELECT g.amount::text FROM gifts_and_payments g
          WHERE g.id = ${activeChargeGiftId}
        )`.as("charge_resolved_gift_amount"),
        resolvedGiftDate: sql<string | null>`(
          SELECT g.date_received::text FROM gifts_and_payments g
          WHERE g.id = ${activeChargeGiftId}
        )`.as("charge_resolved_gift_date"),
        resolvedGiftFiscalYear: sql<string | null>`(
          SELECT ga.grant_year
          FROM gift_allocations ga
          WHERE ga.gift_id = ${activeChargeGiftId}
            AND ga.grant_year IS NOT NULL
          ORDER BY ga.created_at, ga.id
          LIMIT 1
        )`.as("charge_resolved_gift_fy"),
        resolvedGiftAllocations: sql<
          | {
              entityName: string | null;
              usageLabel: string | null;
              regionalRestrictionType: string;
              usageRestrictionType: string;
              timeRestrictionType: string;
            }[]
          | null
        >`(
          SELECT jsonb_agg(
            jsonb_build_object(
              'entityName', e.name,
              'usageLabel', COALESCE(NULLIF(ga.display_usage, ''), ga.intended_usage::text),
              'regionalRestrictionType', ga.regional_restriction_type::text,
              'usageRestrictionType', ga.usage_restriction_type::text,
              'timeRestrictionType', ga.time_restriction_type::text
            ) ORDER BY ga.created_at, ga.id
          )
          FROM gift_allocations ga
          LEFT JOIN entities e ON e.id = ga.entity_id
          WHERE ga.gift_id = ${activeChargeGiftId}
        )`.as("charge_resolved_gift_allocations"),
        autoGiftCount: sql<number>`(
          SELECT COUNT(*)::int FROM gifts_and_payments g WHERE ${unlinkedChargeGiftWhere()}
        )`.as("charge_auto_gift_count"),
        autoGiftPick: sql<{
          id: string;
          name: string | null;
          dateReceived: string | null;
        } | null>`(
          SELECT jsonb_build_object(
            'id', g.id,
            'name', g.name,
            'dateReceived', g.date_received::text
          )
          FROM gifts_and_payments g WHERE ${unlinkedChargeGiftWhere()}
          ORDER BY ABS(g.amount - ${stripeStagedCharges.grossAmount}) ASC
          LIMIT 1
        )`.as("charge_auto_gift_pick"),
      })
      .from(stripePayouts)
      .innerJoin(
        stripeStagedCharges,
        eq(stripeStagedCharges.stripePayoutId, stripePayouts.id),
      )
      .leftJoin(
        settlementLinks,
        eq(settlementLinks.payoutId, stripePayouts.id),
      )
      .where(
        sql`${shouldExpand ? sql`TRUE` : sql`FALSE`}
          AND NOT ${isQbGroupMemberSql()}
          AND ${settlementLinks.depositStagedPaymentId} = ${stagedPayments.id}
          AND ${stripeStagedCharges.exclusionReason} IS NULL`,
      )
      .as("charge_unit");

    conds.push(
      sql`(${chargeSub.chargeId} IS NULL OR ${chargeSub.resolvedGiftId} IS NULL)`,
    );
    const where = conds.length ? and(...conds) : undefined;

    const rows = await withJoins(
      db
        .select({
          ...stagedSelect,
          resolvedGiftDonorName: sql<string | null>`(
            SELECT COALESCE(
              (SELECT o.name FROM organizations o WHERE o.id = g.organization_id),
              (SELECT h.name FROM households h WHERE h.id = g.household_id),
              (SELECT COALESCE(
                        NULLIF(TRIM(pp.full_name), ''),
                        NULLIF(TRIM(CONCAT_WS(' ', pp.first_name, pp.last_name)), '')
                      )
                 FROM people pp WHERE pp.id = g.individual_giver_person_id)
            )
            FROM gifts_and_payments g
            WHERE g.id = COALESCE(
              ${stagedPayments.matchedGiftId},
              ${stagedPayments.createdGiftId},
              ${stagedPayments.groupReconciledGiftId}
            )
          )`,
          finalAmountSource: resolvedGift.finalAmountSource,
          autoGiftCount: autoGiftCountExpr,
          autoGiftPick: autoGiftPickExpr,
          cardReady: readyExpr,
          stripeEvidence: stripeEvidenceExpr,
          sourceGroupId: sql<string | null>`(
            SELECT ugm.group_id FROM unit_group_members ugm
            WHERE ugm.evidence_source = 'quickbooks'
              AND ugm.source_id = ${stagedPayments.id}
            LIMIT 1
          )`.as("source_group_id"),
          sourceGroupAgg: sourceGroupAggExpr,
          recOppId: recCardOpp.id,
          recOppName: recCardOpp.name,
          chargeId: chargeSub.chargeId,
          chargePayoutId: chargeSub.payoutId,
          chargeGross: chargeSub.grossAmount,
          chargeNet: chargeSub.netAmount,
          chargeFee: chargeSub.feeAmount,
          chargeStatus: chargeSub.chargeStatus,
          chargeMatchStatus: chargeSub.matchStatus,
          chargeMatchConfirmedAt: chargeSub.matchConfirmedAt,
          chargeOrganizationId: chargeSub.organizationId,
          chargeIndividualGiverPersonId: chargeSub.individualGiverPersonId,
          chargeHouseholdId: chargeSub.householdId,
          chargePayerName: chargeSub.payerName,
          chargeDonorName: chargeSub.donorName,
          chargeResolvedGiftId: chargeSub.resolvedGiftId,
          chargeResolvedGiftName: chargeSub.resolvedGiftName,
          chargeResolvedGiftDonorName: chargeSub.resolvedGiftDonorName,
          chargeResolvedGiftAmount: chargeSub.resolvedGiftAmount,
          chargeResolvedGiftDate: chargeSub.resolvedGiftDate,
          chargeResolvedGiftFiscalYear: chargeSub.resolvedGiftFiscalYear,
          chargeResolvedGiftAllocations: chargeSub.resolvedGiftAllocations,
          chargeAutoGiftCount: chargeSub.autoGiftCount,
          chargeAutoGiftPick: chargeSub.autoGiftPick,
        })
        .from(stagedPayments)
        .$dynamic(),
    )
      .leftJoin(recCardOpp, eq(recCardOpp.id, resolvedGift.opportunityId))
      .leftJoinLateral(chargeSub, sql`true`)
      .where(where)
      .orderBy(...stagedOrderBy("date_desc"), asc(chargeSub.chargeId))
      .limit(limit)
      .offset(offset);

    const totalRow = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedPayments)
      .leftJoinLateral(chargeSub, sql`true`)
      .where(where);
    const total = totalRow[0]?.count ?? 0;

    const data = rows.map((row) => {
      const isCharge = row.chargeId != null;
      const isSourceGroup = !isCharge && row.sourceGroupId != null;
      const groupAgg = isSourceGroup ? row.sourceGroupAgg : null;
      const donorId = isCharge
        ? (row.chargeOrganizationId ??
          row.chargeIndividualGiverPersonId ??
          row.chargeHouseholdId ??
          null)
        : (row.organizationId ??
          row.individualGiverPersonId ??
          row.householdId ??
          null);
      const donorKind = isCharge
        ? row.chargeOrganizationId
          ? "organization"
          : row.chargeIndividualGiverPersonId
            ? "person"
            : row.chargeHouseholdId
              ? "household"
              : null
        : row.organizationId
          ? "organization"
          : row.individualGiverPersonId
            ? "person"
            : row.householdId
              ? "household"
              : null;
      const donorName = isCharge
        ? (row.chargeDonorName ?? null)
        : (row.organizationName ??
          row.individualGiverPersonName ??
          row.householdName ??
          null);
      const matchStatus = isCharge ? row.chargeMatchStatus : row.matchStatus;
      const donorState =
        donorId == null
          ? "none"
          : matchStatus === "matched"
            ? "determined"
            : "ambiguous";
      const resolvedGiftId = isCharge
        ? (row.chargeResolvedGiftId ?? null)
        : (row.resolvedGiftId ?? null);

      let giftState: string;
      let proposedGiftId: string | null = null;
      let proposedGiftName: string | null = null;
      let proposedGiftDate: string | null = null;
      if (resolvedGiftId) {
        giftState = "determined";
        proposedGiftId = resolvedGiftId;
        proposedGiftName = isCharge
          ? (row.chargeResolvedGiftName ?? null)
          : (row.resolvedGiftName ?? null);
        proposedGiftDate = isCharge
          ? (row.chargeResolvedGiftDate ?? null)
          : (row.resolvedGiftDate ?? null);
      } else if (
        isCharge &&
        row.chargeAutoGiftCount === 1 &&
        row.chargeAutoGiftPick
      ) {
        giftState = "determined";
        proposedGiftId = row.chargeAutoGiftPick.id;
        proposedGiftName = row.chargeAutoGiftPick.name ?? null;
        proposedGiftDate = row.chargeAutoGiftPick.dateReceived ?? null;
      } else if (
        !isCharge &&
        !isSourceGroup &&
        row.autoGiftCount === 1 &&
        row.autoGiftPick
      ) {
        giftState = "determined";
        proposedGiftId = row.autoGiftPick.id;
        proposedGiftName = row.autoGiftPick.name ?? null;
        proposedGiftDate = row.autoGiftPick.dateReceived ?? null;
      } else if (isCharge && (row.chargeAutoGiftCount ?? 0) > 1) {
        giftState = "ambiguous";
      } else if (!isSourceGroup && (row.autoGiftCount ?? 0) > 1) {
        giftState = "ambiguous";
      } else {
        giftState = "none";
      }

      const opportunityState = row.recOppId ? "determined" : "none";
      const laneStatus = isCharge ? (row.chargeStatus ?? row.status) : row.status;
      const donorConfirmed = isCharge
        ? row.chargeMatchConfirmedAt != null
        : row.matchConfirmedAt != null;

      return {
        stagedPaymentId: row.id,
        stripeChargeId: isCharge ? row.chargeId : null,
        status: row.status,
        queue: row.queue,
        amount: isCharge ? (row.chargeGross ?? row.amount) : row.amount,
        dateReceived: row.dateReceived,
        payerName: row.payerName,
        payerEmail: row.payerEmail,
        rawReference: row.rawReference,
        lineDescription: row.lineDescription,
        qbPaymentMethod: row.qbPaymentMethod,
        qbEntityType: row.qbEntityType,
        qbEntityId: row.qbEntityId,
        qbDocNumber: row.qbDocNumber ?? null,
        qbAccountNames: row.lineAccountNames ?? null,
        qbClasses: row.lineClasses ?? null,
        qbItemNames: row.lineItemNames ?? null,
        qbTransactionMemo: row.qbTransactionMemo ?? null,
        qbLocation: row.qbLocation ?? null,
        entityId: row.entityId,
        entityName: row.entityName,
        proposedDonorId: donorId,
        proposedDonorName: donorName,
        proposedDonorKind: donorKind,
        proposedGiftId,
        proposedGiftName,
        proposedOpportunityId: row.recOppId ?? null,
        proposedOpportunityName: row.recOppName ?? null,
        donorState,
        giftState,
        opportunityState,
        hasStripeEvidence: isCharge ? true : row.stripeEvidence != null,
        stripePayoutId: isCharge
          ? (row.chargePayoutId ?? null)
          : (row.stripeEvidence?.payoutId ?? null),
        stripeChargeCount: row.stripeEvidence?.chargeCount ?? null,
        stripeReconciliationStatus:
          row.stripeEvidence?.reconciliationStatus ?? null,
        stripeChargeDonorName: isCharge
          ? (row.chargeDonorName ?? row.chargePayerName ?? null)
          : (row.stripeEvidence?.charge?.payerName ?? null),
        stripeGrossAmount: isCharge
          ? (row.chargeGross ?? null)
          : (row.stripeEvidence?.charge?.grossAmount ?? null),
        stripeNetAmount: isCharge
          ? (row.chargeNet ?? null)
          : (row.stripeEvidence?.charge?.netAmount ?? null),
        stripeFeeAmount: isCharge
          ? (row.chargeFee ?? null)
          : (row.stripeEvidence?.charge?.feeAmount ?? null),
        resolvedGiftId: isCharge
          ? (row.chargeResolvedGiftId ?? null)
          : (row.resolvedGiftId ?? null),
        resolvedGiftName: isCharge
          ? (row.chargeResolvedGiftName ?? null)
          : (row.resolvedGiftName ?? null),
        resolvedGiftDonorName: isCharge
          ? (row.chargeResolvedGiftDonorName ?? null)
          : (row.resolvedGiftDonorName ?? null),
        resolvedGiftAmount: isCharge
          ? (row.chargeResolvedGiftAmount ?? null)
          : (row.resolvedGiftAmount ?? null),
        resolvedGiftDate: proposedGiftDate,
        resolvedGiftFiscalYear: isCharge
          ? (row.chargeResolvedGiftFiscalYear ?? null)
          : (row.resolvedGiftFiscalYear ?? null),
        resolvedGiftAllocations: isCharge
          ? (row.chargeResolvedGiftAllocations ?? null)
          : (row.resolvedGiftAllocations ?? null),
        finalAmountSource: row.finalAmountSource ?? null,
        fundingSource: isSourceGroup
          ? (groupAgg?.commonFundingSource ?? null)
          : (row.fundingSource ?? null),
        fundingSourceProvenance: isSourceGroup
          ? (groupAgg?.commonProvenance ?? null)
          : (row.fundingSourceProvenance ?? null),
        sourceGroupId: isCharge ? null : (row.sourceGroupId ?? null),
        isSourceGroup,
        sourceGroupCount: groupAgg?.count ?? null,
        sourceGroupTotalAmount: groupAgg?.totalAmount ?? null,
        sourceGroupMembers: groupAgg
          ? groupAgg.members.map((member) => ({
              stagedPaymentId: member.stagedPaymentId,
              amount: member.amount ?? null,
              dateReceived: member.dateReceived ?? null,
              payerName: member.payerName ?? null,
              qbDocNumber: member.qbDocNumber ?? null,
              fundingSource: member.fundingSource ?? null,
              isRepresentative: member.stagedPaymentId === row.id,
            }))
          : null,
        objectCode: row.objectCode ?? null,
        objectCodeOverride: row.objectCodeOverride ?? null,
        revenueLocation: row.revenueLocation ?? null,
        revenueLocationOverride: row.revenueLocationOverride ?? null,
        revenueClass: row.revenueClass ?? null,
        revenueClassOverride: row.revenueClassOverride ?? null,
        codingFlags: row.codingFlags ?? null,
        deferredRevenue: row.deferredRevenue ?? null,
        deferredRevenueReason: row.deferredRevenueReason ?? null,
        ready: !isCharge && !isSourceGroup && row.cardReady === true,
        exclusionReason: row.exclusionReason ?? null,
        reconciliationLanes: deriveEvidenceLanes({
          status: laneStatus,
          donorPresent: donorId != null,
          donorConfirmed,
          giftLinked: resolvedGiftId != null,
          giftProposed: giftState !== "none",
        }),
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : (row.createdAt ?? null),
        updatedAt:
          row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : (row.updatedAt ?? null),
      };
    });

    const page = Math.floor(offset / limit) + 1;
    res.json({ data, pagination: { page, limit, total } });
  }),
);

router.get(
  "/reconciliation/cards/:stagedPaymentId/graph",
  asyncHandler(async (req, res) => {
    const rawId = req.params["stagedPaymentId"];
    const id = typeof rawId === "string" ? rawId : "";
    const graph = await buildReconciliationGraph(id, getViewer(req));
    if (!graph) return notFound(res, "reconciliation card");
    res.json(graph);
  }),
);

export default router;
