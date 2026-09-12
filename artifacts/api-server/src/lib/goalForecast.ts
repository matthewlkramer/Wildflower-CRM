import { db } from "@workspace/db";
import {
  fiscalYearEntityGoals,
  giftAllocations,
  giftsAndPayments,
  households,
  opportunitiesAndPledges,
  organizations,
  people,
  pledgeAllocations,
  pledgeExpectedPayments,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { deriveGiftTypeExpr } from "./giftTypeDerived";
import { effectiveProjectedCloseDateSql } from "./effectiveProjectedCloseDate";
import { personDisplayNameSql as personNameSqlFor } from "./personNameSql";

export const FORECAST_CATEGORIES = ["revenue", "loan_capital"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

/** Return today's calendar date in the organization's Chicago timezone. */
export function chicagoCalendarDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

/** Pure date-only comparison used by the funding-arrival overdue action. */
export function isExpectedDateOverdue(
  expectedDate: string,
  today: string = chicagoCalendarDate(),
): boolean {
  return expectedDate < today;
}

export type FundingArrivalMonth = {
  month: string;
  committedAmount: string;
  prospectiveAmount: string;
  prospectiveWeightedAmount: string;
  sourceRecordIds: string[];
};

export type FundingArrivalUnknownTiming = {
  category: ForecastCategory;
  status: "pledge" | "open";
  opportunityId: string;
  opportunityName: string | null;
  amount: string;
  remainingAmount: string;
  sourceRecordIds: string[];
  message: string;
};

export type FundingArrivalAction = {
  type: "overdue" | "missing_timing" | "missing_amount" | "schedule_discrepancy";
  category: ForecastCategory;
  opportunityId: string;
  opportunityName: string | null;
  expectedPaymentId?: string;
  expectedDate?: string;
  amount?: string;
  remainingAmount?: string;
  sourceRecordIds: string[];
  message: string;
};

export type UntimedReimbursementPlan = {
  opportunityId: string;
  opportunityName: string | null;
  allocationId: string;
  entityId: string | null;
  amount: string;
  sourceRecordIds: string[];
};

export type FundingArrivalsByMonth = {
  category: ForecastCategory;
  months: FundingArrivalMonth[];
  unknownTiming: FundingArrivalUnknownTiming[];
  actionableItems: FundingArrivalAction[];
  untimedReimbursementPlans: UntimedReimbursementPlan[];
};
export type ForecastBucket = "received" | "committed" | "open";
export type ForecastScope = {
  fiscalYearId: string | null;
  entityIds?: string[];
  unknownEntityOnly?: boolean;
};

export type ForecastContribution = {
  rowId: string;
  bucket: ForecastBucket;
  amount: string;
  weightedAmount: string | null;
  category: ForecastCategory;
  entityId: string | null;
  intendedUsage: string | null;
  displayUsage: string | null;
  fundableProjectId: string | null;
  giftId: string | null;
  giftType: string | null;
  dateReceived: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  opportunityStage: string | null;
  winProbability: string | null;
  projectedCloseDate: string | null;
  projectedCloseMonthsOut: number | null;
  pledgedAmount: string | null;
  paidAmount: string | null;
  organizationId: string | null;
  organizationName: string | null;
  householdId: string | null;
  householdName: string | null;
  individualGiverPersonId: string | null;
  individualGiverPersonName: string | null;
  organizationPriority: unknown;
  individualGiverPersonPriority: unknown;
};

export type ForecastMetrics = {
  received: string;
  committed: string;
  committedWeighted: string;
  openAsk: string;
  openWeighted: string;
  weightedProjection: string;
  goal: string | null;
  goalGap: string | null;
};

export type GoalForecast = {
  fiscalYearId: string | null;
  receivedRows: ForecastContribution[];
  committedRows: ForecastContribution[];
  openRows: ForecastContribution[];
  metrics: Record<ForecastCategory, ForecastMetrics>;
};

export type ForecastMatrixScope = {
  entityIds?: string[];
  currentFiscalYearId: string;
  nextFiscalYearId: string;
};

export type ForecastMatrix = {
  fiscalYearIds: Array<string | null>;
  entityIds: Array<string | null>;
  cells: Array<{
    fiscalYearId: string | null;
    entityId: string | null;
    forecast: GoalForecast;
  }>;
  combined: Array<{
    fiscalYearId: string | null;
    forecast: GoalForecast;
  }>;
};

export type ForecastDiagnostic = {
  opportunityId: string;
  opportunityName: string | null;
  allocationId: string | null;
  grantYear: string | null;
  entityId: string | null;
  reasons: string[];
  message: string | null;
};

export const categoryFrom = (value: unknown): ForecastCategory =>
  value === "loan" || value === "loan_capital" ? "loan_capital" : "revenue";

const personDisplayNameSql = personNameSqlFor(people);
const effectiveCloseDateExpr = effectiveProjectedCloseDateSql(
  opportunitiesAndPledges.projectedCloseDate,
  opportunitiesAndPledges.projectedCloseMonthsOut,
);
const fyPredicate = (column: any, id: string | null) =>
  id == null ? isNull(column) : eq(column, id);
const scopedEntityPredicate = (
  column: any,
  entityIds: string[],
  unknownOnly = false,
) =>
  unknownOnly
    ? isNull(column)
    : entityIds.length === 0
      ? undefined
      : inArray(column, entityIds);
const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0;
const decimal = (v: number) => {
  if (!Number.isFinite(v) || v === 0) return "0";
  return v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
};

function emptyMetrics(): ForecastMetrics {
  return {
    received: "0.00",
    committed: "0.00",
    committedWeighted: "0.00",
    openAsk: "0.00",
    openWeighted: "0.00",
    weightedProjection: "0.00",
    goal: null,
    goalGap: null,
  };
}

/**
 * The single allocation-grain forecast read model. All callers use these
 * contribution rows and metrics; none should independently subtract payments.
 * Payments are grouped once per opportunity in the requested FY/entity scope,
 * then netted against the opportunity's allocation total.
 */
export async function getGoalForecast(scope: ForecastScope): Promise<GoalForecast> {
  const entityIds = scope.entityIds ?? [];
  const categoryGift = sql<string>`CASE WHEN ${giftsAndPayments.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
  const categoryOpp = sql<string>`CASE WHEN ${opportunitiesAndPledges.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
  const categoryGoal = sql<string>`CASE WHEN ${fiscalYearEntityGoals.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
  const pledgeCounts = sql`(${pledgeAllocations.reimbursementType} IS DISTINCT FROM 'direct' AND NOT (${opportunitiesAndPledges.disbursementModel} = 'cost_reimbursement' AND ${pledgeAllocations.reimbursementType} IS NULL))`;
  const giftCounts = sql`${giftAllocations.reimbursementType} IS DISTINCT FROM 'direct'`;
  const entityFilter = scopedEntityPredicate(giftAllocations.entityId, entityIds, scope.unknownEntityOnly);
  const pledgeEntityFilter = scopedEntityPredicate(pledgeAllocations.entityId, entityIds, scope.unknownEntityOnly);

  const goalEntityFilter = scope.unknownEntityOnly
    ? sql`false`
    : entityIds.length
      ? inArray(fiscalYearEntityGoals.entityId, entityIds)
      : undefined;

  const [received, allocations, payments, goals] = await Promise.all([
    db.select({
      id: giftAllocations.id,
      amount: sql<string>`${giftAllocations.subAmount}::text`,
      entityId: giftAllocations.entityId,
      intendedUsage: sql<string | null>`${giftAllocations.intendedUsage}::text`,
      displayUsage: giftAllocations.displayUsage,
      fundableProjectId: giftAllocations.fundableProjectId,
      giftId: giftAllocations.giftId,
      giftType: sql<string | null>`(${deriveGiftTypeExpr()})::text`,
      dateReceived: sql<string | null>`${giftsAndPayments.dateReceived}::text`,
      organizationId: giftsAndPayments.organizationId,
      organizationName: organizations.name,
      householdId: giftsAndPayments.householdId,
      householdName: households.name,
      individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
      individualGiverPersonName: personDisplayNameSql,
      organizationPriority: organizations.priority,
      individualGiverPersonPriority: people.priority,
      category: categoryGift,
    }).from(giftAllocations)
      .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
      .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
      .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
      .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
      .where(and(
        fyPredicate(giftAllocations.grantYear, scope.fiscalYearId),
        isNull(giftsAndPayments.archivedAt),
        eq(giftAllocations.countsTowardGoal, true),
        giftCounts,
        entityFilter,
      )),
    db.select({
      id: pledgeAllocations.id,
      opportunityId: opportunitiesAndPledges.id,
      opportunityName: opportunitiesAndPledges.name,
      opportunityStage: sql<string | null>`${opportunitiesAndPledges.stage}::text`,
      status: opportunitiesAndPledges.status,
      amount: sql<string | null>`${pledgeAllocations.subAmount}::text`,
      entityId: pledgeAllocations.entityId,
      intendedUsage: sql<string | null>`${pledgeAllocations.intendedUsage}::text`,
      fundableProjectId: pledgeAllocations.fundableProjectId,
      winProbability: sql<string | null>`${opportunitiesAndPledges.winProbability}::text`,
      projectedCloseDate: sql<string | null>`${effectiveCloseDateExpr}::text`,
      projectedCloseMonthsOut: opportunitiesAndPledges.projectedCloseMonthsOut,
      organizationId: opportunitiesAndPledges.organizationId,
      organizationName: organizations.name,
      householdId: opportunitiesAndPledges.householdId,
      householdName: households.name,
      individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
      individualGiverPersonName: personDisplayNameSql,
      organizationPriority: organizations.priority,
      individualGiverPersonPriority: people.priority,
      category: categoryOpp,
      disbursementModel: opportunitiesAndPledges.disbursementModel,
      reimbursementType: pledgeAllocations.reimbursementType,
    }).from(pledgeAllocations)
      .innerJoin(opportunitiesAndPledges, eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId))
      .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
      .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
      .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
      .where(and(
        isNull(opportunitiesAndPledges.archivedAt),
        inArray(opportunitiesAndPledges.status, ["open", "pledge"]),
        eq(opportunitiesAndPledges.isWriteOff, false),
        fyPredicate(pledgeAllocations.grantYear, scope.fiscalYearId),
        pledgeCounts,
        pledgeEntityFilter,
      )),
    db.select({
      opportunityId: giftsAndPayments.opportunityId,
      amount: sql<string>`${giftAllocations.subAmount}::text`,
    }).from(giftAllocations)
      .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
      .innerJoin(opportunitiesAndPledges, eq(opportunitiesAndPledges.id, giftsAndPayments.opportunityId))
      .where(and(
        fyPredicate(giftAllocations.grantYear, scope.fiscalYearId),
        isNull(giftsAndPayments.archivedAt),
        isNull(opportunitiesAndPledges.archivedAt),
        inArray(opportunitiesAndPledges.status, ["open", "pledge"]),
        eq(giftAllocations.countsTowardGoal, true),
        giftCounts,
        entityFilter,
      )),
    db.select({
      goal: sql<string | null>`NULLIF(SUM(${fiscalYearEntityGoals.goalAmount}), 0)::text`,
      category: categoryGoal,
    }).from(fiscalYearEntityGoals).where(and(
      scope.fiscalYearId == null ? sql`false` : eq(fiscalYearEntityGoals.fiscalYearId, scope.fiscalYearId),
      goalEntityFilter,
    )).groupBy(fiscalYearEntityGoals.loanOrGrant),
  ]);

  const paid = new Map<string, number>();
  for (const row of payments) {
    if (row.opportunityId) paid.set(row.opportunityId, (paid.get(row.opportunityId) ?? 0) + num(row.amount));
  }
  const receivedRows: ForecastContribution[] = received.map((row) => ({
    rowId: `received:${row.id}`, bucket: "received", amount: row.amount, weightedAmount: null,
    category: categoryFrom(row.category), entityId: row.entityId, intendedUsage: row.intendedUsage,
    displayUsage: row.displayUsage, fundableProjectId: row.fundableProjectId, giftId: row.giftId,
    giftType: row.giftType, dateReceived: row.dateReceived, opportunityId: null, opportunityName: null,
    opportunityStage: null, winProbability: null, projectedCloseDate: null, projectedCloseMonthsOut: null,
    pledgedAmount: null, paidAmount: null, organizationId: row.organizationId, organizationName: row.organizationName,
    householdId: row.householdId, householdName: row.householdName, individualGiverPersonId: row.individualGiverPersonId,
    individualGiverPersonName: row.individualGiverPersonName, organizationPriority: row.organizationPriority,
    individualGiverPersonPriority: row.individualGiverPersonPriority,
  }));
  const grouped = new Map<string, typeof allocations[number] & { total: number }>();
  const openRows: ForecastContribution[] = [];
  for (const row of allocations) {
    if (row.status === "open") {
      const amount = row.amount ?? "0";
      openRows.push({
        rowId: `open:${row.id}`, bucket: "open", amount,
        weightedAmount: decimal(num(amount) * num(row.winProbability)),
        category: categoryFrom(row.category), entityId: row.entityId, intendedUsage: row.intendedUsage,
        displayUsage: null, fundableProjectId: row.fundableProjectId, giftId: null, giftType: null, dateReceived: null,
        opportunityId: row.opportunityId, opportunityName: row.opportunityName, opportunityStage: row.opportunityStage,
        winProbability: row.winProbability, projectedCloseDate: row.projectedCloseDate,
        projectedCloseMonthsOut: row.projectedCloseMonthsOut, pledgedAmount: null, paidAmount: null,
        organizationId: row.organizationId, organizationName: row.organizationName, householdId: row.householdId,
        householdName: row.householdName, individualGiverPersonId: row.individualGiverPersonId,
        individualGiverPersonName: row.individualGiverPersonName, organizationPriority: row.organizationPriority,
        individualGiverPersonPriority: row.individualGiverPersonPriority,
      });
      continue;
    }
    const key = `${row.opportunityId}|${row.category}|${row.status}`;
    const prior = grouped.get(key);
    if (prior) prior.total += num(row.amount);
    else grouped.set(key, { ...row, total: num(row.amount) });
  }
  const committedRows: ForecastContribution[] = [];
  for (const row of grouped.values()) {
    const remainder = Math.max(0, row.total - (paid.get(row.opportunityId) ?? 0));
    if (remainder <= 0) continue;
    committedRows.push({
      rowId: `committed:${row.opportunityId}`, bucket: "committed", amount: decimal(remainder),
      weightedAmount: decimal(remainder * num(row.winProbability)), category: categoryFrom(row.category),
      entityId: null, intendedUsage: null, displayUsage: null, fundableProjectId: null, giftId: null,
      giftType: null, dateReceived: null, opportunityId: row.opportunityId, opportunityName: row.opportunityName,
      opportunityStage: row.opportunityStage, winProbability: row.winProbability, projectedCloseDate: row.projectedCloseDate,
      projectedCloseMonthsOut: row.projectedCloseMonthsOut, pledgedAmount: decimal(row.total),
      paidAmount: decimal(paid.get(row.opportunityId) ?? 0), organizationId: row.organizationId,
      organizationName: row.organizationName, householdId: row.householdId, householdName: row.householdName,
      individualGiverPersonId: row.individualGiverPersonId, individualGiverPersonName: row.individualGiverPersonName,
      organizationPriority: row.organizationPriority, individualGiverPersonPriority: row.individualGiverPersonPriority,
    });
  }
  const metrics = Object.fromEntries(FORECAST_CATEGORIES.map((category) => {
    const receivedTotal = receivedRows.filter((r) => r.category === category).reduce((s, r) => s + num(r.amount), 0);
    const committedTotal = committedRows.filter((r) => r.category === category).reduce((s, r) => s + num(r.amount), 0);
    const committedWeighted = committedRows.filter((r) => r.category === category).reduce((s, r) => s + num(r.weightedAmount), 0);
    const openTotal = openRows.filter((r) => r.category === category).reduce((s, r) => s + num(r.amount), 0);
    const openWeighted = openRows.filter((r) => r.category === category).reduce((s, r) => s + num(r.weightedAmount), 0);
    const goal = goals.find((g) => categoryFrom(g.category) === category)?.goal ?? null;
    const weightedProjection = receivedTotal + committedWeighted + openWeighted;
    return [category, {
      received: decimal(receivedTotal), committed: decimal(committedTotal), committedWeighted: decimal(committedWeighted),
      openAsk: decimal(openTotal), openWeighted: decimal(openWeighted), weightedProjection: decimal(weightedProjection),
      goal, goalGap: goal == null ? null : decimal(Math.max(0, num(goal) - weightedProjection)),
    }];
  })) as Record<ForecastCategory, ForecastMetrics>;
  return { fiscalYearId: scope.fiscalYearId, receivedRows, committedRows, openRows, metrics };
}

/**
 * Shared timing read model for the funding-arrivals API. Installments are
 * deliberately kept at opportunity grain: expected payments have no
 * recipient attribution, and parent gifts (not gift allocations) are the
 * payment facts used to consume installments oldest-first.
 */
export async function getFundingArrivalsByMonth(
  category: ForecastCategory,
  entityIds: string[] = [],
  today: string = chicagoCalendarDate(),
): Promise<FundingArrivalsByMonth> {
  const categoryPredicate = category === "loan_capital"
    ? eq(opportunitiesAndPledges.loanOrGrant, "loan")
    : sql`${opportunitiesAndPledges.loanOrGrant} IS DISTINCT FROM 'loan'`;
  const activeWriteOffChild = sql`NOT EXISTS (
    SELECT 1
    FROM opportunities_and_pledges AS writeoff_child
    WHERE writeoff_child.write_off_of_pledge_id = ${opportunitiesAndPledges.id}
      AND writeoff_child.archived_at IS NULL
      AND writeoff_child.is_write_off = true
  )`;

  const opportunities = await db
    .select({
      id: opportunitiesAndPledges.id,
      name: opportunitiesAndPledges.name,
      status: sql<"pledge" | "open">`${opportunitiesAndPledges.status}::text`,
      winProbability: sql<string | null>`${opportunitiesAndPledges.winProbability}::text`,
      disbursementModel: opportunitiesAndPledges.disbursementModel,
      loanOrGrant: opportunitiesAndPledges.loanOrGrant,
    })
    .from(opportunitiesAndPledges)
    .where(and(
      isNull(opportunitiesAndPledges.archivedAt),
      inArray(opportunitiesAndPledges.status, ["open", "pledge"]),
      eq(opportunitiesAndPledges.isWriteOff, false),
      activeWriteOffChild,
      categoryPredicate,
    ));

  const result: FundingArrivalsByMonth = {
    category,
    months: [],
    unknownTiming: [],
    actionableItems: [],
    untimedReimbursementPlans: [],
  };
  if (opportunities.length === 0) return result;
  const opportunityIds = opportunities.map((row) => row.id);

  const [allocations, schedules, payments] = await Promise.all([
    db.select({
      id: pledgeAllocations.id,
      opportunityId: pledgeAllocations.pledgeOrOpportunityId,
      entityId: pledgeAllocations.entityId,
      amount: sql<string | null>`${pledgeAllocations.subAmount}::text`,
      reimbursementType: pledgeAllocations.reimbursementType,
    }).from(pledgeAllocations).where(inArray(
      pledgeAllocations.pledgeOrOpportunityId,
      opportunityIds,
    )),
    db.select({
      id: pledgeExpectedPayments.id,
      opportunityId: pledgeExpectedPayments.pledgeOrOpportunityId,
      expectedDate: sql<string>`${pledgeExpectedPayments.expectedDate}::text`,
      amount: sql<string | null>`${pledgeExpectedPayments.amount}::text`,
    }).from(pledgeExpectedPayments).where(inArray(
      pledgeExpectedPayments.pledgeOrOpportunityId,
      opportunityIds,
    )),
    db.select({
      id: giftsAndPayments.id,
      opportunityId: giftsAndPayments.opportunityId,
      amount: sql<string | null>`${giftsAndPayments.amount}::text`,
      dateReceived: sql<string | null>`${giftsAndPayments.dateReceived}::text`,
    }).from(giftsAndPayments).where(and(
      inArray(giftsAndPayments.opportunityId, opportunityIds),
      isNull(giftsAndPayments.archivedAt),
    )),
  ]);

  const selected = new Set(opportunityIds);
  if (entityIds.length > 0) {
    // A schedule is not split by recipient. A parent is selected once when
    // at least one non-direct allocation overlaps the requested scope.
    const overlapping = new Set(
      allocations
        .filter((row) =>
          row.entityId != null &&
          entityIds.includes(row.entityId) &&
          row.reimbursementType !== "direct"
        )
        .map((row) => row.opportunityId),
    );
    for (const id of opportunityIds) {
      if (!overlapping.has(id)) selected.delete(id);
    }
  }

  const monthByKey = new Map<string, FundingArrivalMonth>();
  const unknownByOpportunity = new Map<string, FundingArrivalUnknownTiming>();
  const actions: FundingArrivalAction[] = [];
  const money = (value: string | null | undefined) => num(value);
  const appendMonth = (
    month: string,
    opp: typeof opportunities[number],
    amount: number,
    sourceRecordId?: string,
  ) => {
    if (amount <= 0) return;
    const existing = monthByKey.get(month) ?? {
      month,
      committedAmount: "0",
      prospectiveAmount: "0",
      prospectiveWeightedAmount: "0",
      sourceRecordIds: [],
    };
    if (opp.status === "pledge") {
      existing.committedAmount = decimal(num(existing.committedAmount) + amount);
    } else {
      existing.prospectiveAmount = decimal(num(existing.prospectiveAmount) + amount);
      existing.prospectiveWeightedAmount = decimal(
        num(existing.prospectiveWeightedAmount) +
        amount * money(opp.winProbability),
      );
    }
    if (!existing.sourceRecordIds.includes(opp.id)) existing.sourceRecordIds.push(opp.id);
    if (sourceRecordId != null && !existing.sourceRecordIds.includes(sourceRecordId)) {
      existing.sourceRecordIds.push(sourceRecordId);
    }
    monthByKey.set(month, existing);
  };

  for (const opp of opportunities) {
    if (!selected.has(opp.id)) continue;
    const oppAllocations = allocations.filter((row) =>
      row.opportunityId === opp.id &&
      row.reimbursementType !== "direct",
    );
    // Scope only determines whether the parent schedule is included. Amounts
    // remain parent totals and are never prorated to a recipient.
    const total = oppAllocations.reduce((sum, row) => sum + money(row.amount), 0);
    const oppPayments = payments
      .filter((row) => row.opportunityId === opp.id)
      .sort((a, b) => (a.dateReceived ?? "").localeCompare(b.dateReceived ?? "") || a.id.localeCompare(b.id));
    const paid = oppPayments.reduce((sum, row) => sum + money(row.amount), 0);
    const unpaid = Math.max(0, total - paid);
    const oppSchedules = schedules
      .filter((row) => row.opportunityId === opp.id)
      .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.id.localeCompare(b.id));
    const isReimbursement = opp.disbursementModel === "cost_reimbursement";
    const knownSchedules = oppSchedules.filter((row) => row.amount != null);
    const knownScheduledTotal = knownSchedules.reduce((sum, row) => sum + money(row.amount), 0);

    if (isReimbursement && oppSchedules.length === 0) {
      for (const allocation of oppAllocations) {
        if (allocation.amount == null) continue;
        result.untimedReimbursementPlans.push({
          opportunityId: opp.id,
          opportunityName: opp.name,
          allocationId: allocation.id,
          entityId: allocation.entityId,
          amount: allocation.amount,
          sourceRecordIds: [opp.id, allocation.id],
        });
      }
      continue;
    }
    if (!isReimbursement && oppSchedules.length === 0 && unpaid > 0) {
      actions.push({
        type: "missing_timing",
        category,
        opportunityId: opp.id,
        opportunityName: opp.name,
        remainingAmount: decimal(unpaid),
        sourceRecordIds: [opp.id],
        message: "No installment timing is recorded for the remaining unpaid commitment.",
      });
      unknownByOpportunity.set(opp.id, {
        category,
        status: opp.status,
        opportunityId: opp.id,
        opportunityName: opp.name,
        amount: decimal(total),
        remainingAmount: decimal(unpaid),
        sourceRecordIds: [opp.id],
        message: "Remaining funding has no expected-payment date.",
      });
      continue;
    }
    if (oppSchedules.length === 0) continue;

    // A parent payment is consumed at most once across the whole schedule.
    let paymentRemaining = paid;
    for (const schedule of oppSchedules) {
      if (schedule.amount == null) {
        const unknown = unknownByOpportunity.get(opp.id) ?? {
          category,
          status: opp.status,
          opportunityId: opp.id,
          opportunityName: opp.name,
          amount: decimal(total),
          remainingAmount: decimal(unpaid),
          sourceRecordIds: [opp.id],
          message: "One or more expected-payment dates have no known amount.",
        };
        if (!unknown.sourceRecordIds.includes(schedule.id)) {
          unknown.sourceRecordIds.push(schedule.id);
        }
        unknownByOpportunity.set(opp.id, unknown);
        if (!isReimbursement) {
          actions.push({
            type: "missing_amount",
            category,
            opportunityId: opp.id,
            opportunityName: opp.name,
            expectedPaymentId: schedule.id,
            expectedDate: schedule.expectedDate,
            sourceRecordIds: [opp.id, schedule.id],
            message: "An expected-payment date is recorded, but its amount is unknown.",
          });
        }
        continue;
      }
      const scheduledAmount = money(schedule.amount);
      const allocated = Math.min(paymentRemaining, Math.max(0, scheduledAmount));
      paymentRemaining = Math.max(0, paymentRemaining - allocated);
      const remaining = Math.max(0, scheduledAmount - allocated);
      if (remaining > 0) {
        appendMonth(schedule.expectedDate.slice(0, 7), opp, remaining, schedule.id);
      }
      if (!isReimbursement && remaining > 0 && isExpectedDateOverdue(schedule.expectedDate, today)) {
        actions.push({
          type: "overdue",
          category,
          opportunityId: opp.id,
          opportunityName: opp.name,
          expectedPaymentId: schedule.id,
          expectedDate: schedule.expectedDate,
          amount: schedule.amount,
          remainingAmount: decimal(remaining),
          sourceRecordIds: [opp.id, schedule.id],
          message: "This expected installment is past due and remains unpaid.",
        });
      }
    }
    if (!isReimbursement && Math.abs(knownScheduledTotal - unpaid) > 0.0000001) {
      actions.push({
        type: "schedule_discrepancy",
        category,
        opportunityId: opp.id,
        opportunityName: opp.name,
        amount: decimal(knownScheduledTotal),
        remainingAmount: decimal(unpaid),
        sourceRecordIds: [opp.id, ...oppSchedules.map((row) => row.id)],
        message: "The known installment amounts do not reconcile to the unpaid commitment balance.",
      });
    }
  }

  for (const unknown of unknownByOpportunity.values()) result.unknownTiming.push(unknown);
  result.months = Array.from(monthByKey.values()).sort((a, b) => a.month.localeCompare(b.month));
  result.actionableItems = actions;
  return result;
}

/**
 * Discover and materialize the projections matrix from the same forecast
 * authority as Dashboard and the fiscal-year report. In particular, recipient
 * axes are not inferred from pledge allocations alone: received goal credit
 * and configured goals can create a recipient column before a pledge exists.
 * The null axes are intentional, visible buckets for unknown fiscal years and
 * recipients; they are scoped independently so an unknown cell never receives
 * the all-recipient total.
 */
export async function getForecastMatrix(
  scope: ForecastMatrixScope,
): Promise<ForecastMatrix> {
  const entityIds = scope.entityIds ?? [];
  const entityFilter = entityIds.length
    ? inArray(giftAllocations.entityId, entityIds)
    : undefined;
  const pledgeEntityFilter = entityIds.length
    ? inArray(pledgeAllocations.entityId, entityIds)
    : undefined;
  const goalEntityFilter = entityIds.length
    ? inArray(fiscalYearEntityGoals.entityId, entityIds)
    : undefined;
  const categoryGift = sql<string>`CASE WHEN ${giftsAndPayments.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
  const categoryOpp = sql<string>`CASE WHEN ${opportunitiesAndPledges.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
  const categoryGoal = sql<string>`CASE WHEN ${fiscalYearEntityGoals.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
  const pledgeCounts = sql`(${pledgeAllocations.reimbursementType} IS DISTINCT FROM 'direct' AND NOT (${opportunitiesAndPledges.disbursementModel} = 'cost_reimbursement' AND ${pledgeAllocations.reimbursementType} IS NULL))`;
  const giftCounts = sql`${giftAllocations.reimbursementType} IS DISTINCT FROM 'direct'`;

  const [giftAxes, pledgeAxes, goalAxes] = await Promise.all([
    db.select({
      fiscalYearId: giftAllocations.grantYear,
      entityId: giftAllocations.entityId,
      amount: sql<string | null>`${giftAllocations.subAmount}::text`,
      category: categoryGift,
    }).from(giftAllocations)
      .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
      .where(and(
        isNull(giftsAndPayments.archivedAt),
        eq(giftAllocations.countsTowardGoal, true),
        giftCounts,
        entityFilter,
      )),
    db.select({
      fiscalYearId: pledgeAllocations.grantYear,
      entityId: pledgeAllocations.entityId,
      amount: sql<string | null>`${pledgeAllocations.subAmount}::text`,
      category: categoryOpp,
    }).from(pledgeAllocations)
      .innerJoin(opportunitiesAndPledges, eq(
        opportunitiesAndPledges.id,
        pledgeAllocations.pledgeOrOpportunityId,
      ))
      .where(and(
        isNull(opportunitiesAndPledges.archivedAt),
        inArray(opportunitiesAndPledges.status, ["open", "pledge"]),
        eq(opportunitiesAndPledges.isWriteOff, false),
        pledgeCounts,
        pledgeEntityFilter,
      )),
    db.select({
      fiscalYearId: fiscalYearEntityGoals.fiscalYearId,
      entityId: fiscalYearEntityGoals.entityId,
      amount: sql<string | null>`${fiscalYearEntityGoals.goalAmount}::text`,
      category: categoryGoal,
    }).from(fiscalYearEntityGoals).where(goalEntityFilter),
  ]);

  const fiscalYearIds = new Set<string>([
    scope.currentFiscalYearId,
    scope.nextFiscalYearId,
  ]);
  const recipientIds = new Set<string>(entityIds);
  let hasUnknownFiscalYear = false;
  let hasUnknownRecipient = false;
  for (const row of [...giftAxes, ...pledgeAxes]) {
    const relevant = num(row.amount) > 0;
    if (!relevant) continue;
    if (row.fiscalYearId == null) hasUnknownFiscalYear = true;
    else fiscalYearIds.add(row.fiscalYearId);
    if (row.entityId == null) hasUnknownRecipient = true;
    else recipientIds.add(row.entityId);
  }
  for (const row of goalAxes) {
    if (row.fiscalYearId != null) fiscalYearIds.add(row.fiscalYearId);
    if (row.entityId != null) recipientIds.add(row.entityId);
  }
  const fiscalYearAxis: Array<string | null> = Array.from(fiscalYearIds);
  if (hasUnknownFiscalYear) fiscalYearAxis.push(null);
  const recipientAxis: Array<string | null> = Array.from(recipientIds);
  if (hasUnknownRecipient || recipientAxis.length === 0) recipientAxis.push(null);

  const [combined, cells] = await Promise.all([
    Promise.all(fiscalYearAxis.map(async (fiscalYearId) => ({
      fiscalYearId,
      forecast: await getGoalForecast({ fiscalYearId, entityIds }),
    }))),
    Promise.all(fiscalYearAxis.flatMap((fiscalYearId) =>
      recipientAxis.map(async (entityId) => ({
        fiscalYearId,
        entityId,
        forecast: entityId == null
          ? await getGoalForecast({
              fiscalYearId,
              entityIds: [],
              unknownEntityOnly: true,
            })
          : await getGoalForecast({
              fiscalYearId,
              entityIds: [entityId],
            }),
      })),
    )),
  ]);

  return {
    fiscalYearIds: fiscalYearAxis,
    entityIds: recipientAxis,
    cells,
    combined,
  };
}

export async function getForecastDiagnostics(
  entityIds: string[] = [],
  category?: ForecastCategory,
): Promise<ForecastDiagnostic[]> {
  const rows = await db.select({
    opportunityId: opportunitiesAndPledges.id,
    opportunityName: opportunitiesAndPledges.name,
    status: opportunitiesAndPledges.status,
    disbursementModel: opportunitiesAndPledges.disbursementModel,
    winProbability: opportunitiesAndPledges.winProbability,
    loanOrGrant: opportunitiesAndPledges.loanOrGrant,
    allocationId: pledgeAllocations.id,
    grantYear: pledgeAllocations.grantYear,
    entityId: pledgeAllocations.entityId,
    amount: pledgeAllocations.subAmount,
    reimbursementType: pledgeAllocations.reimbursementType,
  }).from(opportunitiesAndPledges)
    .leftJoin(pledgeAllocations, eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id))
    .where(and(
      isNull(opportunitiesAndPledges.archivedAt),
      inArray(opportunitiesAndPledges.status, ["open", "pledge"]),
      eq(opportunitiesAndPledges.isWriteOff, false),
      category === "loan_capital"
        ? eq(opportunitiesAndPledges.loanOrGrant, "loan")
        : category === "revenue"
          ? sql`${opportunitiesAndPledges.loanOrGrant} IS DISTINCT FROM 'loan'`
          : undefined,
    ));
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.opportunityId) ?? [];
    list.push(row);
    grouped.set(row.opportunityId, list);
  }
  const output: ForecastDiagnostic[] = [];
  for (const [opportunityId, all] of grouped) {
    const scopeRows = entityIds.length === 0
      ? all
      : all.filter((row) => row.entityId == null || entityIds.includes(row.entityId));
    if (all.length > 0 && scopeRows.length === 0) continue;
    const header = all[0];
    const reasons = new Set<string>();
    if (all.length === 0 || all[0].allocationId == null) {
      reasons.add(header.disbursementModel === "cost_reimbursement" ? "unused_capacity" : "no_allocations");
    }
    for (const row of scopeRows) {
      if (row.allocationId == null) continue;
      if (row.amount == null) reasons.add("missing_amount");
      if (row.grantYear == null) reasons.add("missing_fiscal_year");
      if (row.entityId == null) reasons.add("missing_recipient");
      if (row.disbursementModel === "cost_reimbursement" && row.reimbursementType == null) {
        reasons.add("missing_reimbursement_type");
      }
      if (row.reimbursementType === "direct") reasons.add("direct_reimbursement_excluded");
    }
    if (
      header.status === "open" && num(header.winProbability) === 0 &&
      scopeRows.some((row) => row.amount != null && num(row.amount) > 0)
    ) reasons.add("zero_weight_early_prospect");
    if (reasons.size === 0) continue;
    const context = scopeRows.find((row) =>
      row.amount == null || row.grantYear == null || row.entityId == null ||
      row.reimbursementType === "direct"
    ) ?? scopeRows[0];
    output.push({
      opportunityId,
      opportunityName: header.opportunityName,
      allocationId: context?.allocationId ?? null,
      grantYear: context?.grantYear ?? null,
      entityId: context?.entityId ?? null,
      reasons: Array.from(reasons),
      message: reasons.has("unused_capacity")
        ? "Cost-reimbursement award has unused capacity; no drawdown plan is recorded."
        : reasons.has("missing_recipient") &&
        scopeRows.some((row) => row.entityId == null && row.grantYear != null)
        ? "A known-year amount can be included in the all-recipients forecast but is omitted from a selected-recipient forecast until a recipient is assigned."
        : null,
    });
  }
  return output;
}