import { db } from "@workspace/db";
import {
  giftsAndPayments,
  giftAllocations,
  organizations,
  people,
  households,
  regions,
  fiscalYears,
  fundableProjects,
  opportunitiesAndPledges,
  pledgeAllocations,
  tasks,
  stagedPayments,
} from "@workspace/db/schema";
import {
  and,
  eq,
  gte,
  lte,
  isNull,
  inArray,
  or,
  sql,
  arrayOverlaps,
} from "drizzle-orm";
import {
  deriveRevenueCoding,
  describePaymentSchedule,
  deriveDeferredRevenue,
  effectiveCoding,
  type CodingInput,
  type DonorKind,
  type EntityCodingRule,
} from "@workspace/api-zod";
import { maskName, type Viewer } from "./identityVisibility";
import { loadEntityCodingRules } from "./revenueCoding";
import { derivedProcessorFeeForGift } from "./giftPaymentSummary";
import { qbLedgerSoleGiftIdForPayment } from "./paymentApplications";
import { deriveGiftTypeExpr } from "./giftTypeDerived";
import { personDisplayNameSql } from "./personNameSql";

// ── Revenue Extractor report (Task #607) ─────────────────────────────────────
//
// A finance-facing report: one row per gift allocation (plus a separate negative
// processor-fee line per gift that carries fees) with the 19 report columns, all
// DERIVED on demand from the CRM record via the shared coding engine. The CRM is
// the definitive source of the coding inputs; QuickBooks stays authoritative on
// disagreement (surfaced through the qb* comparison fields, read from the linked
// staged_payments coding snapshot). Names are anonymous-masked for non-owners.

export const REVENUE_EXTRACTOR_SOURCE_FILE = "Wildflower CRM";
// Bank-charges expense code for the separate negative processor-fee line
// (mirrors how the finance spreadsheet books Stripe fees).
export const BANK_CHARGES_EXPENSE_CODE = "6560";

export interface RevenueExtractorRow {
  rowKey: string;
  giftId: string;
  allocationId: string | null;
  isFeeLine: boolean;
  // The 19 report columns.
  objectCode: string | null;
  transactionDate: string | null;
  name: string | null;
  location: string | null;
  memoDescription: string | null;
  amount: string | null;
  revenueType: string | null;
  titleReference: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paymentSchedule: string | null;
  restrictionType: string | null;
  purpose: string | null;
  suggestedClass: string | null;
  deferredRevenue: string | null;
  restrictionEvidence: string | null;
  questionsFlags: string | null;
  notes: string | null;
  sourceFile: string | null;
  // QuickBooks coding comparison (QB authoritative).
  qbObjectCode: string | null;
  qbLocation: string | null;
  qbClass: string | null;
  codingDisagreement: boolean;
}

export interface RevenueExtractorReport {
  startDate: string;
  endDate: string;
  generatedAt: string;
  rows: RevenueExtractorRow[];
}

function donorKindOf(row: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}): DonorKind | null {
  if (row.organizationId) return "organization";
  if (row.householdId) return "household";
  if (row.individualGiverPersonId) return "individual";
  return null;
}

// A human-readable questions/flags column: turn the engine's coding flags into
// finance-facing prompts telling the fundraiser what to resolve.
const FLAG_MESSAGES: Record<string, string> = {
  payer_type_assumed:
    "Payer type assumed — set the donor's organization type so the Object Code suffix is definitive.",
  project_location_missing:
    "Project has no Revenue Location — set the fundable project's location code.",
  loan_no_revenue_account:
    "Loan capital — principal movement, no revenue account.",
};

function questionsFromFlags(flags: string[]): string {
  return flags.map((f) => FLAG_MESSAGES[f] ?? f).join(" ");
}

/**
 * Build the Revenue Extractor report for the inclusive [startDate, endDate]
 * transaction-date range. Both dates are ISO (YYYY-MM-DD) and are validated by
 * the caller.
 */
export async function buildRevenueExtractorReport(
  startDate: string,
  endDate: string,
  viewer: Viewer,
): Promise<RevenueExtractorReport> {
  const rules: EntityCodingRule[] = await loadEntityCodingRules();

  // 1. Gifts in range (non-archived), with donor display + masking helpers, the
  //    derived processor fee, and the linked opportunity's grant letter.
  const gifts = await db
    .select({
      id: giftsAndPayments.id,
      dateReceived: giftsAndPayments.dateReceived,
      details: giftsAndPayments.details,
      memoDescription: giftsAndPayments.memoDescription,
      titleReference: giftsAndPayments.titleReference,
      sourceRecordUrl: giftsAndPayments.sourceRecordUrl,
      grantLetterUrl: giftsAndPayments.grantLetterUrl,
      organizationId: giftsAndPayments.organizationId,
      individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
      householdId: giftsAndPayments.householdId,
      opportunityId: giftsAndPayments.opportunityId,
      loanOrGrant: giftsAndPayments.loanOrGrant,
      giftType: deriveGiftTypeExpr(),
      processorFee: derivedProcessorFeeForGift(),
      oppGrantLetterUrl: opportunitiesAndPledges.grantLetterUrl,
      oppWrittenPledge: opportunitiesAndPledges.writtenPledge,
      // Donor display + masking helpers.
      organizationName: organizations.name,
      organizationAnonymous: organizations.anonymous,
      organizationOwnerUserId: organizations.ownerUserId,
      organizationEntityType: organizations.entityType,
      individualGiverPersonName: personDisplayNameSql(people),
      individualGiverAnonymous: people.anonymous,
      individualGiverOwnerUserId: people.ownerUserId,
      householdName: households.name,
    })
    .from(giftsAndPayments)
    .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
    .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
    .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
    .leftJoin(
      opportunitiesAndPledges,
      eq(opportunitiesAndPledges.id, giftsAndPayments.opportunityId),
    )
    .where(
      and(
        isNull(giftsAndPayments.archivedAt),
        gte(giftsAndPayments.dateReceived, startDate),
        lte(giftsAndPayments.dateReceived, endDate),
      ),
    );

  if (gifts.length === 0) {
    return { startDate, endDate, generatedAt: new Date().toISOString(), rows: [] };
  }

  const giftIds = gifts.map((g) => g.id);

  // 2. Allocations for those gifts, with the fund entity, fiscal-year start (for
  //    deferred revenue) and the fundable project location code.
  const allocs = await db
    .select({
      id: giftAllocations.id,
      giftId: giftAllocations.giftId,
      subAmount: giftAllocations.subAmount,
      grantYear: giftAllocations.grantYear,
      entityId: giftAllocations.entityId,
      intendedUsage: giftAllocations.intendedUsage,
      fundableProjectId: giftAllocations.fundableProjectId,
      regionalRestrictionType: giftAllocations.regionalRestrictionType,
      otherRestrictionType: giftAllocations.otherRestrictionType,
      timeRestrictionType: giftAllocations.timeRestrictionType,
      spendingStart: giftAllocations.spendingStart,
      spendingEnd: giftAllocations.spendingEnd,
      regionIds: giftAllocations.regionIds,
      purposeVerbatim: giftAllocations.purposeVerbatim,
      fyStartDate: fiscalYears.startDate,
      projectLocation: fundableProjects.locationCode,
    })
    .from(giftAllocations)
    .leftJoin(fiscalYears, eq(fiscalYears.id, giftAllocations.grantYear))
    .leftJoin(
      fundableProjects,
      eq(fundableProjects.id, giftAllocations.fundableProjectId),
    )
    .where(inArray(giftAllocations.giftId, giftIds));

  // 3. Region state lookup for Hub derivation.
  const regionIdSet = new Set<string>();
  for (const a of allocs) for (const r of a.regionIds ?? []) if (r) regionIdSet.add(r);
  const regionStateMap = new Map<string, string | null>();
  if (regionIdSet.size > 0) {
    const rrows = await db
      .select({ id: regions.id, state: regions.stateAbbreviation })
      .from(regions)
      .where(inArray(regions.id, [...regionIdSet]));
    for (const r of rrows) regionStateMap.set(r.id, r.state ?? null);
  }

  // 4. Reporting-requirement flag: which linked opportunities have a
  //    reporting_deadline task (opportunityIds is a text[] on tasks).
  const oppIds = [
    ...new Set(gifts.map((g) => g.opportunityId).filter((x): x is string => !!x)),
  ];
  const reportingOppIds = new Set<string>();
  if (oppIds.length > 0) {
    const trows = await db
      .select({ opportunityIds: tasks.opportunityIds })
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, "reporting_deadline"),
          arrayOverlaps(tasks.opportunityIds, oppIds),
        ),
      );
    for (const t of trows)
      for (const id of t.opportunityIds ?? [])
        if (id && oppIds.includes(id)) reportingOppIds.add(id);
  }

  // 5. QuickBooks coding snapshot from staged payments linked to these gifts.
  //    Link state comes from the counted cash-application ledger (the legacy
  //    staged gift-link columns are @deprecated and no longer written); a split
  //    payment resolves to NULL, matching the legacy no-columns-set behavior.
  const stagedRows = await db
    .select({
      linkedGiftId: qbLedgerSoleGiftIdForPayment(),
      objectCode: stagedPayments.objectCode,
      objectCodeOverride: stagedPayments.objectCodeOverride,
      revenueLocation: stagedPayments.revenueLocation,
      revenueLocationOverride: stagedPayments.revenueLocationOverride,
      revenueClass: stagedPayments.revenueClass,
      revenueClassOverride: stagedPayments.revenueClassOverride,
    })
    .from(stagedPayments)
    .where(inArray(qbLedgerSoleGiftIdForPayment(), giftIds));
  const qbByGift = new Map<
    string,
    { objectCode: string | null; location: string | null; revenueClass: string | null }
  >();
  for (const s of stagedRows) {
    const giftId = s.linkedGiftId;
    if (!giftId || qbByGift.has(giftId)) continue;
    qbByGift.set(giftId, {
      objectCode: effectiveCoding(s.objectCodeOverride, s.objectCode),
      location: effectiveCoding(s.revenueLocationOverride, s.revenueLocation),
      revenueClass: effectiveCoding(s.revenueClassOverride, s.revenueClass),
    });
  }

  // 6. Fiscal years — for the FISCAL-YEAR-based deferred-revenue test. Deferred
  //    revenue compares the allocation's booked FY to the FY the money was
  //    RECEIVED in (the FY containing the transaction date), not raw dates.
  const fyRows = await db
    .select({
      startDate: fiscalYears.startDate,
      endDate: fiscalYears.endDate,
    })
    .from(fiscalYears);
  const txFyStartForDate = (date: string | null): string | null => {
    if (!date) return null;
    for (const fy of fyRows) {
      if (fy.startDate && fy.endDate && fy.startDate <= date && date <= fy.endDate) {
        return fy.startDate;
      }
    }
    return null;
  };

  // 7. Pledge payment schedule — for gifts whose opportunity is a written
  //    pledge, describe which installment this payment is (position among ALL
  //    the pledge's payments, in or out of range) and what is still expected
  //    (from the pledge's expected payment dates). Non-pledge opportunity gifts
  //    are single payments.
  const pledgeOppIds = [
    ...new Set(
      gifts
        .filter((g) => g.oppWrittenPledge && g.opportunityId)
        .map((g) => g.opportunityId as string),
    ),
  ];
  // opportunityId → this gift's payments ordered by (date, id): installment #.
  const pledgePaymentsByOpp = new Map<string, { id: string; date: string | null }[]>();
  // opportunityId → distinct expected payment dates, ascending.
  const expectedDatesByOpp = new Map<string, string[]>();
  if (pledgeOppIds.length > 0) {
    const pledgeGifts = await db
      .select({
        id: giftsAndPayments.id,
        opportunityId: giftsAndPayments.opportunityId,
        dateReceived: giftsAndPayments.dateReceived,
      })
      .from(giftsAndPayments)
      .where(
        and(
          isNull(giftsAndPayments.archivedAt),
          inArray(giftsAndPayments.opportunityId, pledgeOppIds),
        ),
      );
    for (const pg of pledgeGifts) {
      if (!pg.opportunityId) continue;
      const list = pledgePaymentsByOpp.get(pg.opportunityId) ?? [];
      list.push({ id: pg.id, date: pg.dateReceived });
      pledgePaymentsByOpp.set(pg.opportunityId, list);
    }
    for (const list of pledgePaymentsByOpp.values()) {
      list.sort((a, b) => {
        const ad = a.date ?? "";
        const bd = b.date ?? "";
        if (ad !== bd) return ad < bd ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
    const expectedRows = await db
      .select({
        opportunityId: pledgeAllocations.pledgeOrOpportunityId,
        expectedPaymentDate: pledgeAllocations.expectedPaymentDate,
      })
      .from(pledgeAllocations)
      .where(inArray(pledgeAllocations.pledgeOrOpportunityId, pledgeOppIds));
    const expectedSetByOpp = new Map<string, Set<string>>();
    for (const er of expectedRows) {
      if (!er.opportunityId || !er.expectedPaymentDate) continue;
      const set = expectedSetByOpp.get(er.opportunityId) ?? new Set<string>();
      set.add(er.expectedPaymentDate);
      expectedSetByOpp.set(er.opportunityId, set);
    }
    for (const [oppId, set] of expectedSetByOpp) {
      expectedDatesByOpp.set(oppId, [...set].sort());
    }
  }

  // Group allocations by gift.
  const allocsByGift = new Map<string, typeof allocs>();
  for (const a of allocs) {
    if (!a.giftId) continue;
    const list = allocsByGift.get(a.giftId) ?? [];
    list.push(a);
    allocsByGift.set(a.giftId, list);
  }

  const rows: RevenueExtractorRow[] = [];

  for (const g of gifts) {
    const donorKind = donorKindOf(g);
    const name = maskDonorName(g, viewer);
    const hasGrantLetter = !!(g.grantLetterUrl || g.oppGrantLetterUrl);
    const hasReportingRequirement = !!(
      g.opportunityId && reportingOppIds.has(g.opportunityId)
    );
    // A gift is a pledge installment only when its linked opportunity is a
    // written pledge — not merely any opportunity-linked gift.
    const isPledgePayment = !!(g.oppWrittenPledge && g.opportunityId);
    const qb = qbByGift.get(g.id) ?? null;

    // Pledge installment position + what is still expected.
    let paymentSchedule: string | null;
    if (isPledgePayment && g.opportunityId) {
      const payments = pledgePaymentsByOpp.get(g.opportunityId) ?? [];
      const idx = payments.findIndex((p) => p.id === g.id);
      const installmentNumber = idx >= 0 ? idx + 1 : null;
      const expectedDates = expectedDatesByOpp.get(g.opportunityId) ?? [];
      // Total planned installments = the pledge's distinct expected payment
      // dates when scheduled, otherwise the number of payments recorded.
      const totalInstallments =
        expectedDates.length > 0 ? expectedDates.length : payments.length || null;
      const laterExpected = g.dateReceived
        ? expectedDates.filter((d) => d > (g.dateReceived as string))
        : expectedDates;
      paymentSchedule = describePaymentSchedule({
        isPledgePayment: true,
        installmentNumber,
        totalInstallments,
        remainingExpected: laterExpected.length,
        nextExpectedDate: laterExpected[0] ?? null,
      });
    } else {
      paymentSchedule = describePaymentSchedule({ isPledgePayment: false });
    }

    const txFyStart = txFyStartForDate(g.dateReceived);

    const giftAllocs = allocsByGift.get(g.id) ?? [];

    for (const a of giftAllocs) {
      const input: CodingInput = {
        donorKind,
        orgEntityType: g.organizationEntityType ?? null,
        regionalRestrictionType: a.regionalRestrictionType,
        otherRestrictionType: a.otherRestrictionType,
        timeRestrictionType: a.timeRestrictionType,
        giftType: g.giftType,
        loanOrGrant: g.loanOrGrant,
        entityId: a.entityId,
        intendedUsage: a.intendedUsage,
        fundableProjectId: a.fundableProjectId,
        fundableProjectLocation: a.projectLocation ?? null,
        regionStates: (a.regionIds ?? []).map((r) =>
          r ? regionStateMap.get(r) ?? null : null,
        ),
        hasGrantLetter,
        hasReportingRequirement,
        purposeVerbatim: a.purposeVerbatim,
      };
      const coding = deriveRevenueCoding(input, rules);

      const deferred = deriveDeferredRevenue(txFyStart, a.fyStartDate);

      const disagreement =
        qb != null &&
        ((qb.objectCode != null && qb.objectCode !== coding.objectCode) ||
          (qb.location != null && qb.location !== coding.location) ||
          (qb.revenueClass != null && qb.revenueClass !== coding.revenueClass));

      rows.push({
        rowKey: `${g.id}:${a.id}`,
        giftId: g.id,
        allocationId: a.id,
        isFeeLine: false,
        objectCode: coding.objectCode,
        transactionDate: g.dateReceived,
        name,
        location: coding.location,
        memoDescription: g.memoDescription,
        amount: a.subAmount,
        revenueType: coding.revenueType,
        titleReference: g.titleReference,
        periodStart: a.spendingStart,
        periodEnd: a.spendingEnd,
        paymentSchedule,
        restrictionType: coding.restrictionType,
        purpose: a.purposeVerbatim,
        suggestedClass: coding.revenueClass,
        deferredRevenue: deferred === "yes" ? "Yes" : deferred === "no" ? "No" : "",
        restrictionEvidence: coding.restrictionEvidence,
        questionsFlags: questionsFromFlags(coding.flags),
        notes: g.details,
        sourceFile: g.sourceRecordUrl || REVENUE_EXTRACTOR_SOURCE_FILE,
        qbObjectCode: qb?.objectCode ?? null,
        qbLocation: qb?.location ?? null,
        qbClass: qb?.revenueClass ?? null,
        codingDisagreement: disagreement,
      });
    }

    // Separate negative processor-fee line for gifts with fees. Uses the gift's
    // location (from its first allocation's derived coding, else Foundation
    // General) and the bank-charges expense code.
    const fee = g.processorFee;
    if (fee != null && Number(fee) > 0) {
      const firstAlloc = giftAllocs[0];
      let feeLocation: string | null = "Foundation General";
      if (firstAlloc) {
        const coding = deriveRevenueCoding(
          {
            donorKind,
            orgEntityType: g.organizationEntityType ?? null,
            regionalRestrictionType: firstAlloc.regionalRestrictionType,
            otherRestrictionType: firstAlloc.otherRestrictionType,
            timeRestrictionType: firstAlloc.timeRestrictionType,
            giftType: g.giftType,
            loanOrGrant: g.loanOrGrant,
            entityId: firstAlloc.entityId,
            intendedUsage: firstAlloc.intendedUsage,
            fundableProjectId: firstAlloc.fundableProjectId,
            fundableProjectLocation: firstAlloc.projectLocation ?? null,
            regionStates: (firstAlloc.regionIds ?? []).map((r) =>
              r ? regionStateMap.get(r) ?? null : null,
            ),
          },
          rules,
        );
        feeLocation = coding.location;
      }
      rows.push({
        rowKey: `${g.id}:fee`,
        giftId: g.id,
        allocationId: null,
        isFeeLine: true,
        objectCode: BANK_CHARGES_EXPENSE_CODE,
        transactionDate: g.dateReceived,
        name,
        location: feeLocation,
        memoDescription: "Processor fee",
        amount: `-${Number(fee).toFixed(2)}`,
        revenueType: null,
        titleReference: g.titleReference,
        periodStart: null,
        periodEnd: null,
        paymentSchedule: null,
        restrictionType: null,
        purpose: null,
        suggestedClass: null,
        deferredRevenue: "",
        restrictionEvidence: null,
        questionsFlags: "",
        notes: null,
        sourceFile: REVENUE_EXTRACTOR_SOURCE_FILE,
        qbObjectCode: null,
        qbLocation: null,
        qbClass: null,
        codingDisagreement: false,
      });
    }
  }

  return {
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    rows,
  };
}

function maskDonorName(
  g: {
    organizationName: string | null;
    organizationAnonymous: boolean | null;
    organizationOwnerUserId: string | null;
    individualGiverPersonName: string | null;
    individualGiverAnonymous: boolean | null;
    individualGiverOwnerUserId: string | null;
    householdName: string | null;
  },
  viewer: Viewer,
): string | null {
  if (g.organizationName != null || g.organizationOwnerUserId != null) {
    if (g.organizationName != null || g.organizationAnonymous) {
      return maskName(
        g.organizationName,
        { anonymous: g.organizationAnonymous, ownerUserId: g.organizationOwnerUserId },
        viewer,
      );
    }
  }
  if (g.individualGiverPersonName != null || g.individualGiverOwnerUserId != null) {
    return maskName(
      g.individualGiverPersonName,
      {
        anonymous: g.individualGiverAnonymous,
        ownerUserId: g.individualGiverOwnerUserId,
      },
      viewer,
    );
  }
  return g.householdName ?? null;
}
