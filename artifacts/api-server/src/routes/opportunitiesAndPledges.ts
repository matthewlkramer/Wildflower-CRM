import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import { enqueueDonorSignal } from "../lib/taskSuggestionQueue";
import { opportunitiesAndPledges, pledgeAllocations, giftsAndPayments, giftAllocations, organizations, households, people, tasks, type NewPledgeAllocation } from "@workspace/db/schema";
import { giftSelectWithDerived } from "./giftsAndPayments";
import { oppWorklistConds, type OppWorklist } from "../lib/worklists";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, count, desc, eq, exists, getTableColumns, ilike, inArray, isNull, notExists, or, sql, type SQL } from "drizzle-orm";

// Second `people` alias so we can join *both* the individual giver
// (via individual_giver_person_id) and the primary contact (via
// primary_contact_person_id) in the same query without collision.
const primaryContact = alias(people, "primary_contact_person");

// Returns all opportunity columns plus denormalized donor display names
// (funder / household / individual giver), primary-contact display name,
// the derived fiscal-year slug, and the de-duplicated set of grant
// years from pledge_allocations. Keeps list + detail responses
// self-contained so the UI doesn't fire one fetch per row.
// Person display name matches the client's `personDisplayName`:
// COALESCE(full_name, trim(first||' '||last)).

// Header projection: all opportunity columns. Responses are plain res.json —
// no Zod stripping — so every select/returning that reaches the client must go
// through this projection.
const oppHeaderColumns = getTableColumns(opportunitiesAndPledges);

const donorJoinSelect = {
  ...oppHeaderColumns,
  // Shared donor display names + priorities + anonymous/owner helpers
  // (see lib/donorJoinSelect.ts) — identical to the gifts route.
  ...donorDisplayColumns,
  // Primary contact (opportunities-only): its display name plus the
  // anonymous/owner helpers, masked + stripped in maskOppDonorRow.
  primaryContactAnonymous: primaryContact.anonymous,
  primaryContactOwnerUserId: primaryContact.ownerUserId,
  primaryContactPersonName: personDisplayNameSql(primaryContact).as(
    "primary_contact_person_name",
  ),
  // FY ends Jun 30 in America/Chicago, so Jul-Dec roll forward. We
  // shift the date by 6 months and read the year off — gives the same
  // answer as a CASE on EXTRACT(MONTH) but in fewer ops. Apostrophe-
  // free slug: "FY26". Null when projected_close_date is null.
  fiscalYear: sql<string | null>`
    CASE WHEN ${opportunitiesAndPledges.projectedCloseDate} IS NULL THEN NULL
    ELSE 'FY' || RIGHT(
      EXTRACT(YEAR FROM (${opportunitiesAndPledges.projectedCloseDate}::date + INTERVAL '6 months'))::text,
      2
    ) END
  `.as("fiscal_year"),
  coveredFiscalYears: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT pa.grant_year ORDER BY pa.grant_year)
    FROM pledge_allocations pa
    WHERE pa.pledge_or_opportunity_id = ${opportunitiesAndPledges.id}
      AND pa.grant_year IS NOT NULL
  )`.as("covered_fiscal_years"),
  // Distinct entity slugs from pledge_allocations. Mirrors the gifts
  // route so the opps list/detail can render an Entities column
  // without firing one fetch per row.
  entityIds: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT pa.entity_id ORDER BY pa.entity_id)
    FROM pledge_allocations pa
    WHERE pa.pledge_or_opportunity_id = ${opportunitiesAndPledges.id}
      AND pa.entity_id IS NOT NULL
  )`.as("entity_ids"),
  fundableProjectIds: sql<string[] | null>`(
    SELECT ARRAY_AGG(DISTINCT pa.fundable_project_id ORDER BY pa.fundable_project_id)
    FROM pledge_allocations pa
    WHERE pa.pledge_or_opportunity_id = ${opportunitiesAndPledges.id}
      AND pa.fundable_project_id IS NOT NULL
  )`.as("fundable_project_ids"),
  // Total received against this pledge — SUM(amount) of every
  // gifts_and_payments row whose opportunity_id points at this
  // opp. Returned as a numeric string ("0" when no payments). Lets the
  // pledges UI render a Paid column without one fetch per row.
  paidAmount: sql<string>`(
    SELECT COALESCE(SUM(gp.amount), 0)::text
    FROM gifts_and_payments gp
    WHERE gp.opportunity_id = ${opportunitiesAndPledges.id}
      AND gp.archived_at IS NULL
  )`.as("paid_amount"),
  // True when this pledge carries at least one reimbursable allocation. A
  // reimbursable grant is paid as many real 1:1 reimbursement checks, so the
  // UI warns before booking a single placeholder gift for the full award
  // amount against it (see lib/reimbursablePlaceholder.ts).
  reimbursable: reimbursablePledgeExistsSql(
    sql`${opportunitiesAndPledges.id}`,
  ).as("reimbursable"),
};

import {
  ListOpportunitiesAndPledgesQueryParams,
  CreateOpportunityOrPledgeBodyRefined,
  UpdateOpportunityOrPledgeBody,
  BulkUpdateOpportunitiesAndPledgesBody,
  BulkArchiveOpportunitiesAndPledgesBody,
  WriteOffPledgeBody,
  MintGiftFromOpportunityBody,
  validateOppInvariants,
  validateOppCloseTransition,
  type InvariantIssue,
} from "@workspace/api-zod";
import { copyPledgeAllocationsToGift } from "../lib/reconciliationCommit";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "../lib/giftAllocationSeed";
import { applyDerivedOppFieldsMany } from "../lib/pledgeStage";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, normalizeArrayQuery, notFound, parseOrBadRequest, parsePagination, paramId, splitBlank } from "../lib/helpers";
import { resolvePledgeFreeze, resolvePledgeFreezeById, respondFrozen } from "../lib/freezeGuard";
import { getCurrentOpenFiscalYear, todayInChicago } from "../lib/governingFiscalYear";
import {
  findActiveEditableWriteOffChild,
  findActiveWriteOffChildPledgeId,
  proRataNegativeShares,
} from "../lib/auditCloseResolution";
import { computePledgeUncollectedRemainder } from "../lib/pledgeCapacity";
import { auditCreate, auditUpdate } from "../lib/audit";
import { executeBulkUpdate } from "../lib/bulkUpdate";
import { activeOnlyUnlessAdmin, archiveOne, executeBulkArchive, unarchiveOne } from "../lib/archive";
import {
  applyDerivedOppFields,
  canonicalWinProbability,
  deriveOppFields,
} from "../lib/pledgeStage";
import { reimbursablePledgeExistsSql } from "../lib/reimbursablePlaceholder";
import { isFlaggedForResearch } from "../lib/flaggedForResearch";
import { getViewer, maskName, type Viewer } from "../lib/identityVisibility";
import { personDisplayNameSql } from "../lib/personNameSql";
import {
  donorDisplayColumns,
  maskDonorDisplayFields,
  type DonorDisplayHelperFields,
} from "../lib/donorJoinSelect";

const router: IRouter = Router();
router.use(requireAuth);

// Mask the denormalized donor / primary-contact display names on a
// donorJoinSelect row and strip the anonymous/owner helper aliases so the JSON
// response shape is unchanged. The shared donor fields go through
// maskDonorDisplayFields; the opportunities-only primary contact is layered on
// top here. Households are never anonymizable.
function maskOppDonorRow<
  T extends DonorDisplayHelperFields & {
    primaryContactPersonName: string | null;
    primaryContactAnonymous: boolean | null;
    primaryContactOwnerUserId: string | null;
  },
>(row: T, viewer: Viewer) {
  const { primaryContactAnonymous, primaryContactOwnerUserId, ...rest } =
    maskDonorDisplayFields(row, viewer);
  return {
    ...rest,
    primaryContactPersonName: maskName(
      rest.primaryContactPersonName,
      {
        anonymous: primaryContactAnonymous,
        ownerUserId: primaryContactOwnerUserId,
      },
      viewer,
    ),
  };
}

const OPP_ARRAY_PARAMS = ["fiscalYear", "status", "stage", "type", "ownerUserId", "entityId", "fundableProjectId"] as const;

function respondInvariantFailure(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: { issues: issues.map((i) => ({ path: [i.path], message: i.message })) },
  });
}

router.get(
  "/opportunities-and-pledges",
  asyncHandler(async (req, res) => {
    // Pre-normalize array params so the generated array<…> zod schemas
    // accept the orval comma-form (single string).
    const normalizedQuery = normalizeArrayQuery(
      req.query as Record<string, unknown>,
      OPP_ARRAY_PARAMS,
    );
    // Fiscal-year slugs are stored lowercase (`fy2026`). Preserve
    // the prior route behavior of accepting manually-typed uppercase values
    // by lowercasing here, after the comma-form split.
    if (Array.isArray(normalizedQuery.fiscalYear)) {
      normalizedQuery.fiscalYear = (normalizedQuery.fiscalYear as unknown[]).map(
        (v) => (typeof v === "string" ? v.toLowerCase() : v),
      );
    }
    const q = parseOrBadRequest(ListOpportunitiesAndPledgesQueryParams, normalizedQuery, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) {
      // Search the record name plus the donor display name (org / household /
      // individual giver). The donor tables are already left-joined below, and
      // the count query joins them too. Person name mirrors the
      // individualGiverPersonName expression in donorJoinSelect.
      const term = `%${q.search}%`;
      filters.push(
        or(
          ilike(opportunitiesAndPledges.name, term),
          ilike(organizations.name, term),
          ilike(households.name, term),
          sql`(${personDisplayNameSql(people)}) ILIKE ${term}`,
        )!,
      );
    }
    {
      const f = splitBlank(q.status as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.status), inArray(opportunitiesAndPledges.status, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.status));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.status, f.values as never[]));
    }
    {
      const f = splitBlank(q.stage as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.stage), inArray(opportunitiesAndPledges.stage, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.stage));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.stage, f.values as never[]));
    }
    {
      const f = splitBlank(q.type as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.type), inArray(opportunitiesAndPledges.type, f.values as never[]))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.type));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.type, f.values as never[]));
    }
    if (q.organizationId) filters.push(eq(opportunitiesAndPledges.organizationId, q.organizationId));
    if (q.householdId) filters.push(eq(opportunitiesAndPledges.householdId, q.householdId));
    if (q.individualGiverPersonId) filters.push(eq(opportunitiesAndPledges.individualGiverPersonId, q.individualGiverPersonId));
    {
      const f = splitBlank(q.ownerUserId as string[] | undefined);
      if (f.wantsBlank && f.values.length > 0) filters.push(or(isNull(opportunitiesAndPledges.ownerUserId), inArray(opportunitiesAndPledges.ownerUserId, f.values))!);
      else if (f.wantsBlank) filters.push(isNull(opportunitiesAndPledges.ownerUserId));
      else if (f.values.length > 0) filters.push(inArray(opportunitiesAndPledges.ownerUserId, f.values));
    }
    if (typeof q.writtenPledge === "boolean") filters.push(eq(opportunitiesAndPledges.writtenPledge, q.writtenPledge));
    // Convenience filter that encodes the page split. Commitment now lives on
    // the sticky writtenPledge flag (cultivation stage is a pure funnel), so the
    // split is simply writtenPledge true/false. Legacy committed rows are
    // latched writtenPledge=true by the backfill. See the OpportunityOrPledge
    // schema comments for the rationale.
    if (q.pledgeView === "pledges") {
      filters.push(eq(opportunitiesAndPledges.writtenPledge, true));
    } else if (q.pledgeView === "opportunities") {
      filters.push(eq(opportunitiesAndPledges.writtenPledge, false));
    }
    // Multi-value fiscal-year filter — matches opps that have at least
    // one pledge_allocation row whose grant_year is in the selected set.
    // Use EXISTS rather than a JOIN so we don't fan rows out (one opp
    // with three allocations should still count once).
    // Fiscal-year filter — supports the "(Blank)" sentinel which matches
    // opportunities with no pledge_allocation rows at all. Real fiscal years
    // continue to use the EXISTS pattern so multi-allocation opps don't fan
    // out into duplicate rows.
    {
      const fyRaw = (q.fiscalYear as string[] | undefined) ?? [];
      const { wantsBlank, values: fyValues } = splitBlank(fyRaw);
      const existsClause =
        fyValues.length > 0
          ? exists(
              db
                .select({ one: sql`1` })
                .from(pledgeAllocations)
                .where(
                  and(
                    eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id),
                    inArray(pledgeAllocations.grantYear, fyValues),
                  ),
                ),
            )
          : undefined;
      const noAllocClause = wantsBlank
        ? notExists(
            db
              .select({ one: sql`1` })
              .from(pledgeAllocations)
              .where(eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id)),
          )
        : undefined;
      if (existsClause && noAllocClause) filters.push(or(existsClause, noAllocClause)!);
      else if (existsClause) filters.push(existsClause);
      else if (noAllocClause) filters.push(noAllocClause);
    }
    // Entity filter — same EXISTS pattern as fiscalYear. Matches opps
    // that have at least one pledge_allocation row pinned to one of
    // the requested entity slugs. Driven by the global entity filter
    // in the header (and the opps page's own entity multi-select).
    const entitySelected = q.entityId ?? [];
    if (entitySelected.length > 0) {
      filters.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(pledgeAllocations)
            .where(
              and(
                eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id),
                inArray(pledgeAllocations.entityId, entitySelected),
              ),
            ),
        ),
      );
    }
    const fundableProjectSelected = (q.fundableProjectId as string[] | undefined) ?? [];
    if (fundableProjectSelected.length > 0) {
      filters.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(pledgeAllocations)
            .where(
              and(
                eq(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.id),
                inArray(pledgeAllocations.fundableProjectId, fundableProjectSelected),
              ),
            ),
        ),
      );
    }
    // Presence filters on computed rollup fields (has value vs blank).
    // Each mirrors the matching column expression in donorJoinSelect.
    if (q.paidPresence === "has") {
      filters.push(sql`(SELECT COALESCE(SUM(gp.amount), 0) FROM gifts_and_payments gp WHERE gp.opportunity_id = ${opportunitiesAndPledges.id} AND gp.archived_at IS NULL) > 0`);
    } else if (q.paidPresence === "blank") {
      filters.push(sql`(SELECT COALESCE(SUM(gp.amount), 0) FROM gifts_and_payments gp WHERE gp.opportunity_id = ${opportunitiesAndPledges.id} AND gp.archived_at IS NULL) <= 0`);
    }
    if (q.coveredFysPresence === "has") {
      filters.push(sql`EXISTS (SELECT 1 FROM ${pledgeAllocations} WHERE ${pledgeAllocations.pledgeOrOpportunityId} = ${opportunitiesAndPledges.id} AND ${pledgeAllocations.grantYear} IS NOT NULL)`);
    } else if (q.coveredFysPresence === "blank") {
      filters.push(sql`NOT EXISTS (SELECT 1 FROM ${pledgeAllocations} WHERE ${pledgeAllocations.pledgeOrOpportunityId} = ${opportunitiesAndPledges.id} AND ${pledgeAllocations.grantYear} IS NOT NULL)`);
    }
    if (q.entitiesPresence === "has") {
      filters.push(sql`EXISTS (SELECT 1 FROM ${pledgeAllocations} WHERE ${pledgeAllocations.pledgeOrOpportunityId} = ${opportunitiesAndPledges.id} AND ${pledgeAllocations.entityId} IS NOT NULL)`);
    } else if (q.entitiesPresence === "blank") {
      filters.push(sql`NOT EXISTS (SELECT 1 FROM ${pledgeAllocations} WHERE ${pledgeAllocations.pledgeOrOpportunityId} = ${opportunitiesAndPledges.id} AND ${pledgeAllocations.entityId} IS NOT NULL)`);
    }
    if (q.projectedCloseDatePresence === "has") filters.push(sql`${opportunitiesAndPledges.projectedCloseDate} IS NOT NULL`);
    else if (q.projectedCloseDatePresence === "blank") filters.push(sql`${opportunitiesAndPledges.projectedCloseDate} IS NULL`);
    if (q.applicationDeadlinePresence === "has") filters.push(sql`${opportunitiesAndPledges.applicationDeadline} IS NOT NULL`);
    else if (q.applicationDeadlinePresence === "blank") filters.push(sql`${opportunitiesAndPledges.applicationDeadline} IS NULL`);
    if (q.winProbabilityPresence === "has") filters.push(sql`${opportunitiesAndPledges.winProbability} IS NOT NULL`);
    else if (q.winProbabilityPresence === "blank") filters.push(sql`${opportunitiesAndPledges.winProbability} IS NULL`);
    // Donor-lifecycle worklist preset — composite predicate shared verbatim
    // with the dashboard worklist counts (see lib/worklists).
    if (q.worklist) filters.push(...oppWorklistConds(q.worklist as OppWorklist));
    const archivedFilter = activeOnlyUnlessAdmin(req, opportunitiesAndPledges.archivedAt);
    if (archivedFilter) filters.push(archivedFilter);
    const where = filters.length ? and(...filters) : undefined;
    // Default order is newest projected-close first. Two worklists override it:
    // verbal_no_letter surfaces the stalest (least-recently-updated) first, and
    // partially_paid orders by oldest projected close as a best-effort "overdue"
    // proxy (no expected-payment-date field exists).
    const worklistOrder =
      q.worklist === "verbal_no_letter"
        ? [asc(opportunitiesAndPledges.updatedAt)]
        : q.worklist === "partially_paid"
          ? [sql`${opportunitiesAndPledges.projectedCloseDate} ASC NULLS LAST`]
          : null;
    // Opt-in per-stage SUM(ask_amount) over the FULL filtered set (not just
    // this page) so the pipeline board's column totals stay correct when the
    // row set exceeds the page limit. Reuses the same joins as the count
    // query (search may reference the donor tables).
    const wantStageTotals = q.includeStageAskTotals === true;
    const [rows, [{ value: total } = { value: 0 }], stageTotalRows] = await Promise.all([
      db
        .select(donorJoinSelect)
        .from(opportunitiesAndPledges)
        .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
        .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
        .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
        .leftJoin(primaryContact, eq(primaryContact.id, opportunitiesAndPledges.primaryContactPersonId))
        .where(where)
        .orderBy(...(worklistOrder ?? [desc(opportunitiesAndPledges.projectedCloseDate)]))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
        .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
        .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
        .where(where),
      wantStageTotals
        ? db
            .select({
              stage: opportunitiesAndPledges.stage,
              total: sql<string | null>`SUM(${opportunitiesAndPledges.askAmount})`,
            })
            .from(opportunitiesAndPledges)
            .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
            .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
            .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
            .where(where)
            .groupBy(opportunitiesAndPledges.stage)
        : Promise.resolve([] as { stage: string | null; total: string | null }[]),
    ]);
    const viewer = getViewer(req);
    const data = rows.map((r) => maskOppDonorRow(r, viewer));
    const stageAskTotals = Object.fromEntries(
      stageTotalRows.flatMap((r) =>
        r.stage != null && r.total != null ? [[r.stage, r.total] as const] : [],
      ),
    );
    res.json({
      data,
      pagination: { page, limit, total: Number(total) },
      ...(wantStageTotals ? { stageAskTotals } : {}),
    });
  }),
);

router.get(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db
      .select(donorJoinSelect)
      .from(opportunitiesAndPledges)
      .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
      .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
      .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
      .leftJoin(primaryContact, eq(primaryContact.id, opportunitiesAndPledges.primaryContactPersonId))
      .where(eq(opportunitiesAndPledges.id, id))
      .then((r) => r[0]);
    if (!row) return notFound(res, "opportunity");
    const [
      allocations,
      payments,
      pledgeFreeze,
      uncollectedRaw,
      resolvedByWriteOffPledgeId,
      flaggedForResearch,
    ] = await Promise.all([
      db.select().from(pledgeAllocations).where(eq(pledgeAllocations.pledgeOrOpportunityId, id)),
      // Named gift-header projection for the nested `payments` array.
      db.select(giftSelectWithDerived).from(giftsAndPayments).where(eq(giftsAndPayments.opportunityId, id)),
      // Derived audit-close resolution state (never persisted — see the
      // PledgeAuditCloseResolution schema). Drives the "write off remainder"
      // action; the amount reuses the write-off route's shared helper.
      resolvePledgeFreeze(undefined, row.actualCompletionDate),
      computePledgeUncollectedRemainder(id),
      findActiveWriteOffChildPledgeId(id),
      // Passive "Needs research" badge — driven solely by the Cleanup Queue.
      isFlaggedForResearch(id),
    ]);
    const auditClose = {
      frozen: pledgeFreeze.frozen,
      frozenFiscalYearLabel: pledgeFreeze.frozen ? pledgeFreeze.fiscalYearLabel : null,
      uncollectedRemainder: Math.max(0, uncollectedRaw).toFixed(2),
      resolvedByWriteOffPledgeId,
    };
    res.json({ ...maskOppDonorRow(row, getViewer(req)), allocations, payments, auditClose, flaggedForResearch });
  }),
);

router.post(
  "/opportunities-and-pledges/bulk-update",
  asyncHandler(async (req, res) => {
    await executeBulkUpdate(req, res, {
      entity: "opportunities_and_pledges",
      table: opportunitiesAndPledges,
      bodySchema: BulkUpdateOpportunitiesAndPledgesBody,
      // Fiscal-year freeze: skip (fail) any pledge whose governing FY (its
      // made/won year) is audit-closed, or a completion-date move into one.
      freezeCheck: (existing, cleanPatch) =>
        resolvePledgeFreeze(
          (existing as Record<string, unknown>).actualCompletionDate as
            | string
            | null
            | undefined,
          (cleanPatch as Record<string, unknown>).actualCompletionDate as
            | string
            | null
            | undefined,
        ),
      allowedFields: [
        "ownerUserId",
        "lossType",
        "stage",
        "type",
        "writtenPledge",
        "actualCompletionDate",
        "projectedCloseDate",
        "applicationDeadline",
      ],
      // Allocation-table reconciliation fields — not columns on
      // opportunities_and_pledges, so they go through extraApply and
      // are excluded from the column SET.
      virtualFields: [
        "entities",
        "entitiesMode",
        "coveredFiscalYears",
        "coveredFiscalYearsMode",
        "intendedUsage",
        "fundableProjectId",
      ],
      // Donor xor is preserved (no donor fields in this patch) but is still
      // validated against the merged post-update state. The old
      // closed_requires_completion_date DB CHECK stays dropped (legacy closed
      // rows lack dates); its replacement is the per-row close-TRANSITION
      // check below — a row NEWLY closed by this bulk patch (lossType set, or
      // stage → complete) must end up with an actualCompletionDate, while
      // already-closed rows pass untouched.
      validateRow: (existing, patch) => {
        const ex = existing as Record<string, unknown>;
        const merged = { ...ex, ...patch } as Record<string, unknown>;
        const issues = [
          ...validateOppInvariants({
            organizationId: merged.organizationId as string | null | undefined,
            individualGiverPersonId: merged.individualGiverPersonId as string | null | undefined,
            householdId: merged.householdId as string | null | undefined,
            status: merged.status as string | null | undefined,
            actualCompletionDate: merged.actualCompletionDate as string | Date | null | undefined,
          }),
          ...validateOppCloseTransition(
            {
              lossType: ex.lossType as string | null | undefined,
              stage: ex.stage as string | null | undefined,
              actualCompletionDate: ex.actualCompletionDate as string | Date | null | undefined,
            },
            patch as {
              lossType?: string | null;
              stage?: string | null;
              actualCompletionDate?: string | Date | null;
            },
          ),
        ];
        return issues.length ? issues.map((i) => i.message).join("; ") : null;
      },
      // After a successful bulk write, recompute derived fields per row
      // — bulk patches commonly flip stage or status, which can change
      // written_pledge (sticky-true) or trigger the written_commitment→cash_in
      // auto-advance once payments are in.
      afterApply: async (id) => {
        await applyDerivedOppFields(id);
      },
      // Reconcile pledge_allocations rows so the opportunity's
      // covered FYs match the requested set. Replace = wipe existing
      // allocations and recreate one minimal row per FY (DESTRUCTIVE
      // — loses subAmount/intendedUsage/etc on those rows). Append =
      // insert allocations only for FYs not already represented.
      extraApply: async (tx, id, vp) => {
        const v = vp as {
          entities?: string[];
          entitiesMode?: string;
          coveredFiscalYears?: string[];
          coveredFiscalYearsMode?: string;
          intendedUsage?: NewPledgeAllocation["intendedUsage"];
          fundableProjectId?: string | null;
        };
        // Reconcile pledge_allocations.entity_id like gifts' entityIds:
        // replace wipes allocation rows whose entity_id is set and
        // recreates one minimal row per entity (DESTRUCTIVE); append
        // adds rows only for entities not already present.
        if (v.entities) {
          const mode = v.entitiesMode === "append" ? "append" : "replace";
          if (mode === "replace") {
            await tx
              .delete(pledgeAllocations)
              .where(
                and(
                  eq(pledgeAllocations.pledgeOrOpportunityId, id),
                  sql`${pledgeAllocations.entityId} IS NOT NULL`,
                ),
              );
          }
          const existingEntities =
            mode === "append"
              ? (
                  await tx
                    .select({ e: pledgeAllocations.entityId })
                    .from(pledgeAllocations)
                    .where(eq(pledgeAllocations.pledgeOrOpportunityId, id))
                )
                  .map((r: { e: string | null }) => r.e)
                  .filter((e: string | null): e is string => !!e)
              : [];
          for (const entityId of v.entities.filter((e) => !existingEntities.includes(e))) {
            await tx.insert(pledgeAllocations).values({
              id: newId(),
              pledgeOrOpportunityId: id,
              entityId,
            });
          }
        }
        const fys = v.coveredFiscalYears;
        if (fys) {
          const mode = v.coveredFiscalYearsMode === "append" ? "append" : "replace";
          if (mode === "replace") {
            await tx
              .delete(pledgeAllocations)
              .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
          }
          const existingFys =
            mode === "append"
              ? (
                  await tx
                    .select({ y: pledgeAllocations.grantYear })
                    .from(pledgeAllocations)
                    .where(eq(pledgeAllocations.pledgeOrOpportunityId, id))
                )
                  .map((r: { y: string | null }) => r.y)
                  .filter((y: string | null): y is string => !!y)
              : [];
          const toInsert = fys.filter((fy) => !existingFys.includes(fy));
          for (const fy of toInsert) {
            await tx.insert(pledgeAllocations).values({
              id: newId(),
              pledgeOrOpportunityId: id,
              grantYear: fy,
            });
          }
        }
        // Intended usage applies to ALL of the opportunity's allocation
        // rows. Update every existing row to the chosen value; if the opp
        // has no allocation rows at all, create a single one carrying it
        // so the value is recorded. Mirrors the gifts route. The fundable
        // project link is only meaningful for usage = 'project': set it on
        // every row in that case, and clear it (null) for any other usage
        // so stale links don't linger.
        if (v.intendedUsage) {
          const fundableProjectId =
            v.intendedUsage === "project" ? (v.fundableProjectId ?? null) : null;
          const existing = await tx
            .select({ id: pledgeAllocations.id })
            .from(pledgeAllocations)
            .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
          if (existing.length > 0) {
            await tx
              .update(pledgeAllocations)
              .set({
                intendedUsage: v.intendedUsage,
                fundableProjectId,
                updatedAt: new Date(),
              })
              .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
          } else {
            await tx.insert(pledgeAllocations).values({
              id: newId(),
              pledgeOrOpportunityId: id,
              intendedUsage: v.intendedUsage,
              fundableProjectId,
            });
          }
        }
      },
    });
  }),
);

router.post(
  "/opportunities-and-pledges",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateOpportunityOrPledgeBodyRefined, req.body, res);
    if (!body) return;
    // Freeze guard: refuse to create a pledge whose made/won date lands in an
    // audit-closed FY.
    const freeze = await resolvePledgeFreeze(
      undefined,
      body.actualCompletionDate as string | Date | null | undefined,
    );
    if (freeze.frozen) return respondFrozen(res, freeze);
    // Stamp canonical win_probability on insert when caller provided a
    // stage/lossType but no explicit win_probability — same rule as the
    // PATCH path. status is fully calculated, so derive it first and key
    // win_probability off the derived value. Explicit winProbability in
    // the body always wins. (applyDerivedOppFields below is authoritative
    // and re-canonicalises once payments are known.)
    const writeValues: typeof body & {
      winProbability?: string | null;
    } = { ...body };
    // loanOrGrant comes straight from the body (authoritative flag); omitted →
    // the DB default 'grant'.
    if (
      (body.stage !== undefined || body.lossType !== undefined) &&
      body.winProbability === undefined
    ) {
      // Grant conditions moved onto pledge allocations (Task #449); a brand-new
      // opportunity has none yet, so it defaults to non-conditional (90%).
      // applyDerivedOppFields below re-canonicalises from the allocation rollup
      // once allocations are added.
      const derivedStatus = deriveOppFields({
        stage: body.stage ?? null,
        lossType: body.lossType ?? null,
        writtenPledge: body.writtenPledge ?? null,
        conditional: null,
        grantLetterUrl: body.grantLetterUrl ?? null,
        awardedAmount: body.awardedAmount ?? null,
        paidAmount: 0,
      }).status;
      const wp = canonicalWinProbability(
        derivedStatus,
        body.stage ?? null,
        null,
      );
      if (wp !== null) writeValues.winProbability = wp;
    }
    const [row] = await db
      .insert(opportunitiesAndPledges)
      .values({ id: newId(), ...writeValues })
      .returning(oppHeaderColumns);
    if (row) {
      await applyDerivedOppFields(row.id);
      // New opportunity/pledge is a fresh relationship signal — refresh the
      // donor's cached next-step suggestion (debounced + priority-gated).
      enqueueDonorSignal({
        organizationId: row.organizationId,
        individualGiverPersonId: row.individualGiverPersonId,
      });
    }
    const final = row
      ? (await db.select(oppHeaderColumns).from(opportunitiesAndPledges).where(eq(opportunitiesAndPledges.id, row.id)).then((r) => r[0])) ?? row
      : row;
    if (final) await auditCreate(req, "opportunity", final.id, "Created opportunity");
    res.status(201).json(final);
  }),
);

// Write off some or all of the uncollected remainder of an audited (frozen),
// under-paid written pledge. The audited original is NEVER mutated — a
// write-off is a NEW negative offsetting pledge booked in the current open FY
// (see the audit-close model). The amount is the caller's choice, capped at
// the remainder NET of prior active write-offs (omitted = the full net
// balance); recording a received payment and reducing the pledge are
// INDEPENDENT decisions. Multiple write-offs may accumulate over time, but at
// most one EDITABLE (open-FY) one at a time — while one exists the correction
// belongs on it, so a new write-off is refused.
//
// CONCURRENCY: the guards + capacity computation + insert all run inside ONE
// transaction that first locks the original pledge row FOR UPDATE (precedent:
// mergeEntities). That app-level serialization is the ONLY protection against
// two concurrent write-offs over-shooting the remainder — the old partial
// UNIQUE index (one active write-off per original) is gone by design.
router.post(
  "/opportunities-and-pledges/:id/write-off",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(WriteOffPledgeBody, req.body, res);
    if (!body) return;

    // Amount FORMAT is validated before any DB work (pure). Positivity/format
    // failures are 400s; the state-dependent cap check happens under the lock.
    let requestedCents: number | null = null;
    if (body.amount != null) {
      const raw = String(body.amount).trim();
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
        return res.status(400).json({
          error: "invalid_amount",
          message:
            "amount must be a positive dollar figure with at most 2 decimal places.",
        });
      }
      requestedCents = Math.round(Number(raw) * 100);
      if (!Number.isFinite(requestedCents) || requestedCents <= 0) {
        return res.status(400).json({
          error: "invalid_amount",
          message: "amount must be greater than zero.",
        });
      }
    }

    // A guard failure inside the transaction is captured here and answered
    // after rollback-free exit (nothing is written before the final inserts).
    let failure: { status: number; body: Record<string, unknown> } | null =
      null;
    const fail = (status: number, b: Record<string, unknown>) => {
      failure = { status, body: b };
    };

    const writeOffId = newId();
    await db.transaction(async (tx) => {
      // Serialize concurrent write-offs of the same pledge: every competing
      // request queues on this row lock and re-reads a fresh capacity.
      const original = await tx
        .select()
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.id, id))
        .for("update")
        .then((r) => r[0]);
      if (!original) return fail(404, { error: "not_found" });

      if (original.isWriteOff) {
        return fail(409, {
          error: "invalid_write_off_target",
          message:
            "This record is itself a write-off and cannot be written off.",
        });
      }
      if (!original.writtenPledge) {
        return fail(409, {
          error: "invalid_write_off_target",
          message: "Only a written pledge can be written off.",
        });
      }

      // The governing FY must be audit-closed. If it is still open, the
      // mismatch is corrected in place (edit the pledge/allocations) — the
      // write-off is the post-close mechanism, not a shortcut around edits.
      const freeze = await resolvePledgeFreeze(
        undefined,
        original.actualCompletionDate,
      );
      if (!freeze.frozen) {
        return fail(409, {
          error: "fiscal_year_not_closed",
          message:
            "This pledge's fiscal year is still open — correct it in place instead of writing it off.",
        });
      }

      // At most one EDITABLE (open-FY) active write-off at a time. While one
      // exists, a further reduction belongs on it (edit it in place); only
      // once it is itself audit-closed may a NEW write-off be booked.
      const editable = await findActiveEditableWriteOffChild(id, tx);
      if (editable) {
        return fail(409, {
          error: "editable_write_off_exists",
          message:
            "This pledge already has a write-off in the current open fiscal year — edit that write-off instead of creating another.",
          details: {
            writeOffPledgeId: editable.id,
            writeOffPledgeName: editable.name,
          },
        });
      }

      // Capacity = committed − paid, NET of prior active write-offs, computed
      // fresh UNDER THE LOCK so concurrent requests can't both pass. Derived
      // by the shared helper so the detail's `uncollectedRemainder` (the
      // dialog prefill) and the cap enforced here can never diverge. The
      // allocation rows are fetched separately for the pro-rata split.
      const allocs = await tx
        .select()
        .from(pledgeAllocations)
        .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
      const capacity = await computePledgeUncollectedRemainder(id, tx);
      if (capacity <= 0) {
        return fail(409, {
          error: "nothing_to_write_off",
          message: "This pledge has no uncollected remainder to write off.",
        });
      }
      const capacityCents = Math.round(capacity * 100);
      const amountCents = requestedCents ?? capacityCents;
      if (amountCents > capacityCents) {
        return fail(409, {
          error: "amount_exceeds_remainder",
          message: `The write-off amount exceeds the pledge's remaining uncollected balance (${capacity.toFixed(2)}).`,
          details: { maxAmount: capacity.toFixed(2) },
        });
      }
      const amount = amountCents / 100;

      // The write-off is booked in the current open FY; if none is open there
      // is nowhere valid to recognise the correction.
      const openFy = await getCurrentOpenFiscalYear();
      if (!openFy) {
        return fail(409, {
          error: "no_open_fiscal_year",
          message: "There is no open fiscal year to book the write-off into.",
        });
      }

      // Split the chosen amount across the positive-weight source buckets
      // (weight = the original allocation's sub_amount). capacity > 0
      // guarantees at least one such bucket, so proRataNegativeShares never
      // throws here.
      const buckets = allocs.filter((a) => Number(a.subAmount ?? 0) > 0);
      const shares = proRataNegativeShares(
        buckets.map((a) => Number(a.subAmount)),
        amount,
      );

      await tx.insert(opportunitiesAndPledges).values({
        id: writeOffId,
        name: original.name ? `Write-off — ${original.name}` : "Write-off",
        // Donor XOR: copy all three FKs (exactly one is non-null on the source).
        organizationId: original.organizationId,
        individualGiverPersonId: original.individualGiverPersonId,
        householdId: original.householdId,
        writtenPledge: true,
        isWriteOff: true,
        writeOffOfPledgeId: id,
        awardedAmount: (-amount).toFixed(2),
        // Recognised today, which falls inside the open FY window — keeps the
        // write-off itself governed by an open (mutable) FY.
        actualCompletionDate: todayInChicago(),
        loanOrGrant: original.loanOrGrant,
        usageNotes: body.reason ?? null,
      });
      // Mirror each source bucket's scope with a NEGATIVE sub_amount, all booked
      // in the open FY so the write-off lands there in the analytics rollups.
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i]!;
        await tx.insert(pledgeAllocations).values({
          id: newId(),
          pledgeOrOpportunityId: writeOffId,
          subAmount: shares[i]!,
          grantYear: openFy.id,
          entityId: b.entityId,
          intendedUsage: b.intendedUsage,
          fundableProjectId: b.fundableProjectId,
          schoolRecipientId: b.schoolRecipientId,
          directToSchool: b.directToSchool,
          regionalRestrictionType: b.regionalRestrictionType,
          otherRestrictionType: b.otherRestrictionType,
          timeRestrictionType: b.timeRestrictionType,
          reimbursementType: b.reimbursementType,
          regionIds: b.regionIds,
        });
      }
    });
    if (failure) {
      const f = failure as { status: number; body: Record<string, unknown> };
      if (f.status === 404) return notFound(res, "opportunity");
      return res.status(f.status).json(f.body);
    }
    // Derive status/stage/win_probability on the new write-off. writtenPledge is
    // sticky-true (never cleared) so it derives as status='pledge'; the negative
    // awarded amount keeps it out of cash_in (which needs awarded > 0).
    await applyDerivedOppFields(writeOffId);
    const final = await db
      .select(oppHeaderColumns)
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, writeOffId))
      .then((r) => r[0]);
    if (final) {
      await auditCreate(
        req,
        "opportunity",
        final.id,
        `Wrote off uncollected remainder of pledge ${id}`,
      );
    }
    res.status(201).json(final);
  }),
);

// Proactively mint a real gift from an opportunity/pledge (the "won gift" and
// "won gift awaiting imminent payment" actions on the opportunity detail). This
// is the money-first counterpart to the reconciliation path: instead of a bank
// event minting a gift, the fundraiser records the win up front. All money,
// donor, and scope are DERIVED from the opportunity (never supplied by the
// client) so the gift inherits the pledge's scope; the only choice is whether to
// stamp `awaiting_settlement` (so the fresh, cash-tie-less gift is not treated
// as a reconciliation error while payment is imminent). Never blocks: a scope-
// less opp still mints a header + a seeded default allocation.
router.post(
  "/opportunities-and-pledges/:id/mint-gift",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(MintGiftFromOpportunityBody, req.body, res);
    if (!body) return;

    const opp = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .then((r) => r[0]);
    if (!opp) return notFound(res, "opportunity");

    // A write-off is a negative offsetting correction, not a winnable ask — it
    // must never mint a gift.
    if (opp.isWriteOff) {
      return res.status(409).json({
        error: "invalid_mint_target",
        message: "A write-off record cannot be turned into a gift.",
      });
    }

    // Donor XOR: copy all three FKs straight from the opportunity (its own
    // num_nonnulls = 1 CHECK guarantees exactly one is set), so the minted gift
    // inherits the same single donor without re-deriving it.
    const donorFks = {
      organizationId: opp.organizationId,
      individualGiverPersonId: opp.individualGiverPersonId,
      householdId: opp.householdId,
    };

    // Recognised today (Chicago), which lands inside the current open FY window.
    // Amount = the awarded amount when the ask has been sized, else the ask.
    const dateReceived = todayInChicago();
    const amount = opp.awardedAmount ?? opp.askAmount ?? null;
    const awaitingSettlement = body.awaitingSettlement ?? false;

    const giftId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(giftsAndPayments).values({
        id: giftId,
        name: opp.name,
        ...donorFks,
        opportunityId: opp.id,
        amount,
        dateReceived,
        awaitingSettlement,
        // Authoritative loan-vs-grant flag carried over from the opportunity.
        loanOrGrant: opp.loanOrGrant,
      });
      // Inherit the pledge's scope onto the gift's allocations, scaled to the
      // gift amount (forward gift intake). Falls back to a single seeded
      // default allocation when the opp has no allocation lines, so the gift
      // never lands scope-less. Either way the gift-has-allocations invariant
      // holds.
      await copyPledgeAllocationsToGift(tx, opp.id, giftId, amount);
      const [{ n: allocCount }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(giftAllocations)
        .where(eq(giftAllocations.giftId, giftId));
      if (!allocCount) {
        await seedInitialGiftAllocation(tx, {
          giftId,
          amount,
          dateReceived,
        });
      }
      await assertGiftHasAllocations(tx, giftId);
    });

    // Re-derive the opportunity's calculated lifecycle (a linked gift moves it
    // toward cash_in) and stamp the new gift's QuickBooks tie status.
    await applyDerivedOppFieldsMany(opp.id);
    const gift = await db
      .select(giftSelectWithDerived)
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .then((r) => r[0]);
    if (gift) {
      await auditCreate(
        req,
        "gift",
        gift.id,
        awaitingSettlement
          ? `Minted gift awaiting settlement from opportunity ${id}`
          : `Minted gift from opportunity ${id}`,
      );
    }
    res.status(201).json(gift);
  }),
);

router.patch(
  "/opportunities-and-pledges/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateOpportunityOrPledgeBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    const existing = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "opportunity");

    // Validate merged post-update state against DB invariants so we return
    // 400 instead of letting a partial PATCH trip the CHECK constraint as a 500.
    const merged = { ...existing, ...body };
    const issues = validateOppInvariants({
      organizationId: merged.organizationId,
      individualGiverPersonId: merged.individualGiverPersonId,
      householdId: merged.householdId,
      status: merged.status,
      actualCompletionDate: merged.actualCompletionDate,
    });
    if (issues.length) return respondInvariantFailure(res, issues);

    // Close-transition rule: a PATCH that NEWLY closes this row (sets lossType
    // dormant/lost, or stage → complete) must leave it with an
    // actualCompletionDate. Already-closed rows (incl. legacy no-date rows)
    // are never blocked — the rule fires only on the transition itself.
    const closeIssues = validateOppCloseTransition(existing, body);
    if (closeIssues.length) return respondInvariantFailure(res, closeIssues);

    // Freeze guard: block edits to a pledge whose governing FY is audit-closed,
    // and block moving actual_completion_date into a closed FY.
    const freeze = await resolvePledgeFreeze(
      existing.actualCompletionDate,
      merged.actualCompletionDate as string | Date | null | undefined,
    );
    if (freeze.frozen) return respondFrozen(res, freeze);

    // Canonical-win-probability rule: whenever the PATCH touches stage
    // or lossType, re-derive win_probability from the new (calculated
    // status, stage) pair — overwriting any past user override. status
    // is fully calculated, so derive it from the merged lossType + stage
    // first. If the same PATCH also explicitly sets winProbability, let
    // the explicit value win. (applyDerivedOppFields below is
    // authoritative and re-canonicalises once payments are known.)
    const stageOrLossTypeInBody =
      body.stage !== undefined || body.lossType !== undefined;
    const writeData: typeof body & {
      winProbability?: string | null;
    } = {
      ...body,
    };
    // loanOrGrant (authoritative flag) flows straight from the body when set.
    if (stageOrLossTypeInBody && body.winProbability === undefined) {
      // Conditions live on the pledge allocations now; the inline stamp uses the
      // non-conditional default and applyDerivedOppFields below re-canonicalises
      // win_probability from the allocation conditional rollup.
      const derivedStatus = deriveOppFields({
        stage: merged.stage ?? null,
        lossType: merged.lossType ?? null,
        writtenPledge: merged.writtenPledge ?? null,
        conditional: null,
        grantLetterUrl: merged.grantLetterUrl ?? null,
        awardedAmount: merged.awardedAmount ?? null,
        paidAmount: 0,
      }).status;
      const wp = canonicalWinProbability(
        derivedStatus,
        merged.stage,
        null,
      );
      if (wp !== null) writeData.winProbability = wp;
    }

    const [row] = await db
      .update(opportunitiesAndPledges)
      .set({ ...writeData, updatedAt: new Date() })
      .where(eq(opportunitiesAndPledges.id, id))
      .returning(oppHeaderColumns);
    if (!row) return notFound(res, "opportunity");
    // The patch may have changed stage, awardedAmount, or status — any
    // of which can flip written_pledge sticky-true, change the derived
    // status, or trigger the written_commitment→cash_in auto-advance
    // (which itself re-canonicalises win_probability inside the helper).
    await applyDerivedOppFields(id);
    const final = await db
      .select(oppHeaderColumns)
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .then((r) => r[0]);

    // Reporting-deadline prompt side-channel: when this PATCH flips
    // status into a state with grant-reporting obligations (pledge or
    // cash_in) AND no reporting_deadline tasks exist yet for this
    // opp, surface a flag so the frontend can open the "set deadlines"
    // dialog. Idempotent — once the user creates the first
    // reporting_deadline task the flag goes away on subsequent
    // PATCHes.
    let promptForReportingDeadlines = false;
    const newStatus = (final ?? row).status;
    const becameReportable =
      (newStatus === "pledge" || newStatus === "cash_in") &&
      existing.status !== newStatus;
    if (becameReportable) {
      const [{ value: existingCount } = { value: 0 }] = await db
        .select({ value: count() })
        .from(tasks)
        .where(and(
          eq(tasks.kind, "reporting_deadline"),
          sql`${tasks.opportunityIds} @> ARRAY[${id}]::text[]`,
        ));
      if (Number(existingCount) === 0) promptForReportingDeadlines = true;
    }

    // Revenue coding is no longer a persisted snapshot on the allocation
    // (Task #449) — it's derived on demand from the allocation's scope + the
    // gift/opportunity donor, so a donor change needs no allocation rewrite.

    await auditUpdate(req, "opportunity", row.id, existing as Record<string, unknown>, (final ?? row) as Record<string, unknown>, Object.keys(body), "Updated opportunity");
    res.json({ ...(final ?? row), promptForReportingDeadlines });
  }),
);

router.post(
  "/opportunities-and-pledges/bulk-archive",
  asyncHandler(async (req, res) => {
    await executeBulkArchive(req, res, {
      entity: "opportunities_and_pledges",
      table: opportunitiesAndPledges,
      bodySchema: BulkArchiveOpportunitiesAndPledgesBody,
      freezeResolver: resolvePledgeFreezeById,
    });
  }),
);

router.post(
  "/opportunities-and-pledges/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, {
      entity: "opportunity",
      table: opportunitiesAndPledges,
      responseColumns: oppHeaderColumns,
      freezeResolver: resolvePledgeFreezeById,
    });
  }),
);

router.post(
  "/opportunities-and-pledges/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, {
      entity: "opportunity",
      table: opportunitiesAndPledges,
      responseColumns: oppHeaderColumns,
      freezeResolver: resolvePledgeFreezeById,
    });
  }),
);

export default router;
