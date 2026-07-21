import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  people,
  households,
  organizations,
  opportunitiesAndPledges,
  pledgeAllocations,
  giftsAndPayments,
  giftAllocations,
  fiscalYears,
  fiscalYearEntityGoals,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import {
  oppWorklistCountWhere,
  giftWorklistCountWhere,
  stagedPendingWhere,
} from "../lib/worklists";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound } from "../lib/helpers";
import { personDisplayNameSql as personNameSqlFor } from "../lib/personNameSql";
import { deriveGiftTypeExpr } from "../lib/giftTypeDerived";

// Person display name — the canonical chain shared with the rest of the
// API (see lib/personNameSql.ts).
const personDisplayNameSql = personNameSqlFor(people);

const router: IRouter = Router();
router.use(requireAuth);

// Wildflower fiscal year: July 1 — June 30 (Wildflower books in
// America/Chicago). FY label = end-year. e.g. May 24 2026 → FY 2026
// (started 2025-07-01, ends 2026-06-30).
//
// The boundary is a calendar date in the org's local timezone, not UTC —
// using getUTCMonth/getUTCFullYear caused the FY to flip up to a day
// early/late around midnight on Jun 30 / Jul 1 depending on where the
// server was running. We resolve "now" to its Chicago calendar date via
// Intl.DateTimeFormat (the only timezone-aware date primitive in Node
// without a third-party dep) and pick the FY from that.
const FY_TIMEZONE = "America/Chicago";

// en-CA → "YYYY-MM-DD" parts, which we can read directly.
const FY_DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: FY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type FyDescriptor = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
};

function fyFromEndYear(fyEndYear: number): FyDescriptor {
  const fyStartYear = fyEndYear - 1;
  return {
    id: `fy${fyEndYear}`,
    label: `FY ${fyEndYear}`,
    startDate: `${fyStartYear}-07-01`,
    endDate: `${fyEndYear}-06-30`,
  };
}

function computeCurrentFiscalYear(now: Date = new Date()): FyDescriptor {
  const parts = FY_DATE_PARTS.formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value); // 1-12
  const fyEndYear = m >= 7 ? y + 1 : y;
  return fyFromEndYear(fyEndYear);
}

// Per-FY money rollup. All amounts are decimal strings (PostgreSQL numeric)
// to preserve precision through JSON. See SCHEMA.md for why we sum
// gift_allocations / pledge_allocations at the line-item level rather than
// the parent header (multi-year commitments are split across allocation
// rows with their own grant_year slugs).
// ─── Fundraising category (revenue vs loan_capital) ─────────────────────────
// Loan-fund capital reports as a track parallel to revenue, never mixed in.
// A002 READ CUTOVER: the bucket string for every track is now DERIVED from the
// authoritative `loan_or_grant` flag on each table (loan → loan_capital,
// grant → revenue), no longer from the scattered legacy signals (gift type /
// fundraising_category / goal category). The response keys + downstream
// bucketing stay on the legacy `revenue`/`loan_capital` slugs until A003 — only
// the SOURCE column changed, so existing data + API consumers are unaffected.
const FUNDRAISING_CATEGORIES = ["revenue", "loan_capital"] as const;
type FundraisingCategory = (typeof FUNDRAISING_CATEGORIES)[number];

// loan_or_grant → legacy bucket string, one helper per source table.
const giftCategorySql = sql<string>`CASE WHEN ${giftsAndPayments.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
const oppCategorySql = sql<string>`CASE WHEN ${opportunitiesAndPledges.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;
const goalCategorySql = sql<string>`CASE WHEN ${fiscalYearEntityGoals.loanOrGrant} = 'loan' THEN 'loan_capital' ELSE 'revenue' END`;

type CategoryMetrics = {
  openPipelineAsk: string;
  openPipelineWeighted: string;
  committed: string;
  committedWeighted: string;
  received: string;
  // Audit-close write-offs booked into THIS FY: the (negative) sum of
  // is_write_off pledge allocations. A settled correction, not an open ask —
  // surfaced as its own negative "written off" line, never folded into
  // committed / open-pipeline / received.
  writtenOff: string;
  goal: string | null;
};

function emptyCategoryMetrics(): CategoryMetrics {
  return {
    openPipelineAsk: "0",
    openPipelineWeighted: "0",
    committed: "0",
    committedWeighted: "0",
    received: "0",
    writtenOff: "0",
    goal: null,
  };
}

function isFundraisingCategory(v: unknown): v is FundraisingCategory {
  return v === "revenue" || v === "loan_capital";
}

// Goal analytics EXCLUDE direct-tagged reimbursable allocation lines. Untagged
// (null) and indirect both still count, so use IS DISTINCT FROM (null-safe).
// Recording is non-destructive: the full award/reimbursement amount stays on the
// allocation; only the goal rollups (received, committed, open ask, weighted)
// drop the direct share. This must NEVER be applied to opportunity-status or
// pledge paid-amount derivation (those keep summing ALL allocations so cash_in
// still fires on full reimbursement).
const pledgeAllocCountsTowardGoal = sql`${pledgeAllocations.reimbursementType} IS DISTINCT FROM 'direct'`;
const giftAllocCountsTowardGoal = sql`${giftAllocations.reimbursementType} IS DISTINCT FROM 'direct'`;

async function fyMetricsFor(fy: FyDescriptor, entityIds?: string[]) {
  // Entity scoping is applied at the allocation level (both pledge_allocations
  // and gift_allocations carry an entity_id). An empty/undefined list means
  // "all entities" — pass-through with no filter. The goal is summed from
  // the per-entity `fiscal_year_entity_goals` table, also entity-scoped.
  const hasEntityFilter = !!entityIds && entityIds.length > 0;

  // Per-opp pledged amount for this FY (status='pledge' written commitments).
  // Carries the opp's fundraising category so `committed` splits by track.
  const pledgedPerOpp = db
    .select({
      oppId: sql<string>`${pledgeAllocations.pledgeOrOpportunityId}`.as("pledged_opp_id"),
      category: oppCategorySql.as("pledged_category"),
      pledged: sql<string>`SUM(${pledgeAllocations.subAmount})`.as("pledged"),
      // Win-probability is per-opp; the derivation sets it to 0.90 for an unpaid
      // written pledge (0.75 if conditional). Carried through so the weighted
      // commitment line discounts pledges instead of counting them at 100%.
      winProb: sql<string>`MAX(${opportunitiesAndPledges.winProbability})`.as("pledged_win_prob"),
    })
    .from(pledgeAllocations)
    .innerJoin(
      opportunitiesAndPledges,
      eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
    )
    .where(
      and(
        eq(opportunitiesAndPledges.status, "pledge"),
        // Audit-close write-offs are status='pledge' too, but they are a
        // settled negative correction — keep them out of `committed` (they get
        // their own `writtenOff` line below).
        eq(opportunitiesAndPledges.isWriteOff, false),
        eq(pledgeAllocations.grantYear, fy.id),
        pledgeAllocCountsTowardGoal,
        hasEntityFilter ? inArray(pledgeAllocations.entityId, entityIds!) : undefined,
      ),
    )
    .groupBy(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.loanOrGrant)
    .as("pledged_per_opp");

  // Payments already booked against those pledges, scoped to the same FY +
  // entities as `received`, so we only ever subtract money `received` counts.
  const paidPerOpp = db
    .select({
      oppId: sql<string>`${giftsAndPayments.opportunityId}`.as("paid_opp_id"),
      paid: sql<string>`SUM(${giftAllocations.subAmount})`.as("paid"),
    })
    .from(giftAllocations)
    .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
    .where(
      and(
        eq(giftAllocations.grantYear, fy.id),
        // Archived gifts (e.g. a QB lump superseded by a Stripe REPLACE) are
        // never counted as payments — keep them out of `paid` so `committed`
        // (pledged − paid) doesn't get artificially reduced by dead money.
        isNull(giftsAndPayments.archivedAt),
        // Allocations flagged out of goal tracking neither add to `received` nor
        // pay down `committed`, so the goal numbers stay internally consistent.
        eq(giftAllocations.countsTowardGoal, true),
        giftAllocCountsTowardGoal,
        hasEntityFilter ? inArray(giftAllocations.entityId, entityIds!) : undefined,
      ),
    )
    .groupBy(giftsAndPayments.opportunityId)
    .as("paid_per_opp");

  const [openRows, committedRows, receivedRows, writtenOffRows, goalRows] = await Promise.all([
    db
      .select({
        category: oppCategorySql,
        ask: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount}), 0)::text`,
        weighted: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount} * ${opportunitiesAndPledges.winProbability}), 0)::text`,
      })
      .from(pledgeAllocations)
      .innerJoin(
        opportunitiesAndPledges,
        eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
      )
      .where(
        and(
          eq(opportunitiesAndPledges.status, "open"),
          // A write-off never reads status='open' (it's a written pledge), but
          // exclude it explicitly so the open-pipeline ask can never absorb one.
          eq(opportunitiesAndPledges.isWriteOff, false),
          eq(pledgeAllocations.grantYear, fy.id),
          pledgeAllocCountsTowardGoal,
          hasEntityFilter
            ? inArray(pledgeAllocations.entityId, entityIds!)
            : undefined,
        ),
      )
      .groupBy(opportunitiesAndPledges.loanOrGrant),
    // "Committed" = UNPAID remainder of written commitments (status='pledge')
    // for this FY: pledged amount minus payments already received against each
    // pledge (see pledgedPerOpp / paidPerOpp above). This dedupes partial
    // payments — the paid portion stays in `received`, only the not-yet-paid
    // portion lands in `committed`, so received + committed + openPipelineWeighted
    // counts each dollar once. GREATEST(..,0) clamps each opp's remainder at
    // zero so an over-paid-this-year pledge can't offset another opp.
    db
      .select({
        category: sql<string>`${pledgedPerOpp.category}`,
        v: sql<string>`COALESCE(SUM(GREATEST(${pledgedPerOpp.pledged} - COALESCE(${paidPerOpp.paid}, 0), 0)), 0)::text`,
        // Same unpaid remainder, but discounted by the pledge's win-probability
        // (0.90 non-conditional / 0.75 conditional). This is the figure the
        // projection tile uses — an unpaid written pledge is NOT counted at 100%.
        weighted: sql<string>`COALESCE(SUM(GREATEST(${pledgedPerOpp.pledged} - COALESCE(${paidPerOpp.paid}, 0), 0) * ${pledgedPerOpp.winProb}), 0)::text`,
      })
      .from(pledgedPerOpp)
      .leftJoin(paidPerOpp, eq(pledgedPerOpp.oppId, paidPerOpp.oppId))
      .groupBy(pledgedPerOpp.category),
    db
      .select({
        category: giftCategorySql,
        v: sql<string>`COALESCE(SUM(${giftAllocations.subAmount}), 0)::text`,
      })
      .from(giftAllocations)
      // Join the parent gift so archived gifts can be excluded from `received`
      // (archived = doesn't count). Without this, a REPLACE would double-count
      // the superseded QB lump alongside its per-charge Stripe gifts.
      .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
      .where(
        and(
          eq(giftAllocations.grantYear, fy.id),
          isNull(giftsAndPayments.archivedAt),
          eq(giftAllocations.countsTowardGoal, true),
          giftAllocCountsTowardGoal,
          hasEntityFilter
            ? inArray(giftAllocations.entityId, entityIds!)
            : undefined,
        ),
      )
      .groupBy(giftCategorySql),
    // Audit-close write-offs booked INTO this FY. The write-off pledge's
    // allocations carry grant_year = the open FY they were recognised in and a
    // NEGATIVE sub_amount, so this sums to a negative "written off" line per
    // category. Keyed on is_write_off (not status) so it's independent of the
    // derived pledge status.
    //
    // NOT unified with pledgeCapacity.ts on purpose: capacity is a PER-PLEDGE
    // figure (a pledge's own allocations + its write-off children's, netted
    // against ITS paid rollup, no FY/goal scoping), while this is a fiscal-
    // year GOAL bucket — write-off rows selected by their OWN grant_year /
    // countsTowardGoal / entity filters, grouped by category, and never
    // combined with committed or paid into a remainder. Same rows, different
    // aggregation semantics; folding this into the capacity helper would
    // force FY/goal parameters onto a per-pledge derivation that must stay
    // scope-free.
    db
      .select({
        category: oppCategorySql,
        v: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount}), 0)::text`,
      })
      .from(pledgeAllocations)
      .innerJoin(
        opportunitiesAndPledges,
        eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
      )
      .where(
        and(
          eq(opportunitiesAndPledges.isWriteOff, true),
          eq(pledgeAllocations.grantYear, fy.id),
          pledgeAllocCountsTowardGoal,
          hasEntityFilter
            ? inArray(pledgeAllocations.entityId, entityIds!)
            : undefined,
        ),
      )
      .groupBy(opportunitiesAndPledges.loanOrGrant),
    db
      .select({
        category: goalCategorySql,
        goal: sql<string | null>`NULLIF(SUM(${fiscalYearEntityGoals.goalAmount}), 0)::text`,
      })
      .from(fiscalYearEntityGoals)
      .where(
        and(
          eq(fiscalYearEntityGoals.fiscalYearId, fy.id),
          hasEntityFilter
            ? inArray(fiscalYearEntityGoals.entityId, entityIds!)
            : undefined,
        ),
      )
      .groupBy(fiscalYearEntityGoals.loanOrGrant),
  ]);

  const byCategory: Record<FundraisingCategory, CategoryMetrics> = {
    revenue: emptyCategoryMetrics(),
    loan_capital: emptyCategoryMetrics(),
  };
  for (const r of openRows) {
    if (!isFundraisingCategory(r.category)) continue;
    byCategory[r.category].openPipelineAsk = r.ask;
    byCategory[r.category].openPipelineWeighted = r.weighted;
  }
  for (const r of committedRows) {
    if (!isFundraisingCategory(r.category)) continue;
    byCategory[r.category].committed = r.v;
    byCategory[r.category].committedWeighted = r.weighted;
  }
  for (const r of receivedRows) {
    if (!isFundraisingCategory(r.category)) continue;
    byCategory[r.category].received = r.v;
  }
  for (const r of writtenOffRows) {
    if (!isFundraisingCategory(r.category)) continue;
    byCategory[r.category].writtenOff = r.v;
  }
  for (const r of goalRows) {
    if (!isFundraisingCategory(r.category)) continue;
    byCategory[r.category].goal = r.goal ?? null;
  }

  return {
    fiscalYear: fy,
    revenue: byCategory.revenue,
    loanCapital: byCategory.loan_capital,
  };
}

// Parse `entityIds` from a query string. Orval generates form/explode=false
// arrays as comma-joined strings (`?entityIds=a,b,c`), and Express also tolerates
// repeated keys (`?entityIds=a&entityIds=b`). Accept both, drop empties.
function parseEntityIdsParam(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const parts: string[] = [];
  const consume = (v: unknown) => {
    if (typeof v !== "string") return;
    for (const piece of v.split(",")) {
      const trimmed = piece.trim();
      if (trimmed) parts.push(trimmed);
    }
  };
  if (Array.isArray(raw)) raw.forEach(consume);
  else consume(raw);
  return parts;
}

router.get(
  "/dashboard-summary",
  asyncHandler(async (req, res) => {
    const entityIds = parseEntityIdsParam(req.query.entityIds);
    const currentFy = computeCurrentFiscalYear();
    const nextFy = fyFromEndYear(Number(currentFy.id.slice(2)) + 1);

    const [
      [{ value: peopleCt }],
      [{ value: orgsCt }],
      [{ value: householdsCt }],
      [{ value: oppsCt }],
      [{ value: openCt }],
      [{ value: pledgesCt }],
      [{ value: giftsCt }],
      // Donor-lifecycle worklist counts — entity-scoped, archived excluded.
      // Predicates are shared verbatim with the filtered-list worklists.
      [{ value: verbalNoLetterCt }],
      [{ value: committedUnpaidCt }],
      [{ value: partiallyPaidCt }],
      [{ value: stagedPaymentsPendingCt }],
      [{ value: stripeChargesPendingCt }],
      [{ value: giftsMissingAllocCt }],
      currentFyMetrics,
      nextFyMetrics,
    ] = await Promise.all([
      db.select({ value: count() }).from(people),
      db.select({ value: count() }).from(organizations),
      db.select({ value: count() }).from(households),
      db.select({ value: count() }).from(opportunitiesAndPledges),
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.status, "open")),
      // Pledges-page count: written_pledge=true OR stage ∈ pledge stages.
      // Mirrors the pledgeView=pledges filter in the opps list route.
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(
          sql`(${opportunitiesAndPledges.writtenPledge} = true OR ${opportunitiesAndPledges.stage} IN ('conditional_commitment','written_commitment'))`,
        ),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .where(isNull(giftsAndPayments.archivedAt)),
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(oppWorklistCountWhere("verbal_no_letter", entityIds)),
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(oppWorklistCountWhere("committed_unpaid", entityIds)),
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(oppWorklistCountWhere("partially_paid", entityIds)),
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(stagedPendingWhere(stagedPayments, entityIds, true)),
      db
        .select({ value: count() })
        .from(stripeStagedCharges)
        .where(stagedPendingWhere(stripeStagedCharges, entityIds, false)),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .where(giftWorklistCountWhere("missing_allocations", entityIds)),
      fyMetricsFor(currentFy, entityIds),
      fyMetricsFor(nextFy, entityIds),
    ]);

    res.json({
      counts: {
        people: Number(peopleCt),
        organizations: Number(orgsCt),
        households: Number(householdsCt),
        opportunities: Number(oppsCt),
        openOpportunities: Number(openCt),
        pledges: Number(pledgesCt),
        gifts: Number(giftsCt),
      },
      worklists: {
        verbalNoLetter: Number(verbalNoLetterCt),
        committedUnpaid: Number(committedUnpaidCt),
        partiallyPaid: Number(partiallyPaidCt),
        stagedUnprocessed: Number(stagedPaymentsPendingCt) + Number(stripeChargesPendingCt),
        giftsMissingAllocations: Number(giftsMissingAllocCt),
      },
      currentFiscalYear: currentFy,
      byFiscalYear: [currentFyMetrics, nextFyMetrics],
    });
  }),
);

// Per-FY drilldown for a single dashboard money tile. Returns the
// supporting rows for "Received" (gift_allocations) and "Open asks" /
// "Weighted asks" (pledge_allocations on open opps), plus the FY's goal.
// Donor info is denormalized via three LEFT JOINs (mirrors the
// donor_xor invariant — exactly one of funder/household/person is set).
router.get(
  "/fiscal-year-breakdown/:fyId",
  asyncHandler(async (req, res) => {
    // Path param matches the OpenAPI operation parameter name (`fyId`);
    // the shared `paramId` helper only reads `req.params.id`, so we read
    // this one directly.
    const fyId = String(req.params.fyId ?? "");
    if (!fyId) return notFound(res, "fiscal year");
    const entityIdParam =
      typeof req.query.entityId === "string" && req.query.entityId.trim()
        ? req.query.entityId.trim()
        : null;

    const fyRow = await db
      .select({
        id: fiscalYears.id,
        startDate: sql<string>`${fiscalYears.startDate}::text`,
        endDate: sql<string>`${fiscalYears.endDate}::text`,
      })
      .from(fiscalYears)
      .where(eq(fiscalYears.id, fyId))
      .then((r) => r[0]);
    if (!fyRow) return notFound(res, "fiscal year");

    // Goal is summed from the per-entity goals table, scoped by entity if
    // the request narrows to one, and split by category. Returns null per
    // category when no goals are recorded.
    const goalRows = await db
      .select({
        category: goalCategorySql,
        goal: sql<string | null>`NULLIF(SUM(${fiscalYearEntityGoals.goalAmount}), 0)::text`,
      })
      .from(fiscalYearEntityGoals)
      .where(
        and(
          eq(fiscalYearEntityGoals.fiscalYearId, fyId),
          entityIdParam ? eq(fiscalYearEntityGoals.entityId, entityIdParam) : undefined,
        ),
      )
      .groupBy(fiscalYearEntityGoals.loanOrGrant);
    const goalByCategory: Record<FundraisingCategory, string | null> = {
      revenue: null,
      loan_capital: null,
    };
    for (const r of goalRows) {
      if (isFundraisingCategory(r.category)) goalByCategory[r.category] = r.goal ?? null;
    }

    // FY slug format is `fy<endYear>` (see analytics.ts fyFromEndYear).
    // Label keeps that convention even when sourced from the DB row.
    const endYear = Number(fyId.slice(2));
    const fiscalYear = {
      id: fyRow.id,
      label: `FY ${endYear}`,
      startDate: fyRow.startDate,
      endDate: fyRow.endDate,
    };

    const [receivedRows, openRows] = await Promise.all([
      db
        .select({
          allocationId: giftAllocations.id,
          subAmount: sql<string>`${giftAllocations.subAmount}::text`,
          category: giftCategorySql,
          entityId: giftAllocations.entityId,
          intendedUsage: sql<string | null>`${giftAllocations.intendedUsage}::text`,
          displayUsage: giftAllocations.displayUsage,
          fundableProjectId: giftAllocations.fundableProjectId,
          giftId: giftAllocations.giftId,
          giftType: sql<string | null>`(${deriveGiftTypeExpr()})::text`,
          dateReceived: sql<string | null>`${giftsAndPayments.dateReceived}::text`,
          giftAmount: sql<string | null>`${giftsAndPayments.amount}::text`,
          organizationId: giftsAndPayments.organizationId,
          organizationName: organizations.name,
          householdId: giftsAndPayments.householdId,
          householdName: households.name,
          individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
          individualGiverPersonName: personDisplayNameSql,
          organizationPriority: organizations.priority,
          individualGiverPersonPriority: people.priority,
        })
        .from(giftAllocations)
        .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
        .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
        .where(
          and(
            eq(giftAllocations.grantYear, fyId),
            // Mirror the dashboard tile: archived gifts and allocations flagged
            // out of goal tracking don't count, so the drill-down rows (and their
            // API-edge total) stay in agreement with the tile.
            isNull(giftsAndPayments.archivedAt),
            eq(giftAllocations.countsTowardGoal, true),
            giftAllocCountsTowardGoal,
            entityIdParam ? eq(giftAllocations.entityId, entityIdParam) : undefined,
          ),
        )
        .orderBy(desc(giftsAndPayments.dateReceived)),
      db
        .select({
          allocationId: pledgeAllocations.id,
          subAmount: sql<string>`${pledgeAllocations.subAmount}::text`,
          weightedAmount: sql<string>`(${pledgeAllocations.subAmount} * ${opportunitiesAndPledges.winProbability})::text`,
          category: oppCategorySql,
          allocationStatus: sql<string | null>`${pledgeAllocations.status}::text`,
          entityId: pledgeAllocations.entityId,
          intendedUsage: sql<string | null>`${pledgeAllocations.intendedUsage}::text`,
          fundableProjectId: pledgeAllocations.fundableProjectId,
          opportunityId: pledgeAllocations.pledgeOrOpportunityId,
          opportunityName: opportunitiesAndPledges.name,
          opportunityStage: sql<string | null>`${opportunitiesAndPledges.stage}::text`,
          winProbability: sql<string | null>`${opportunitiesAndPledges.winProbability}::text`,
          projectedCloseDate: sql<string | null>`${opportunitiesAndPledges.projectedCloseDate}::text`,
          organizationId: opportunitiesAndPledges.organizationId,
          organizationName: organizations.name,
          householdId: opportunitiesAndPledges.householdId,
          householdName: households.name,
          individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
          individualGiverPersonName: personDisplayNameSql,
          organizationPriority: organizations.priority,
          individualGiverPersonPriority: people.priority,
        })
        .from(pledgeAllocations)
        .innerJoin(
          opportunitiesAndPledges,
          eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
        )
        .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
        .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
        .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
        .where(
          and(
            eq(opportunitiesAndPledges.status, "open"),
            eq(pledgeAllocations.grantYear, fyId),
            pledgeAllocCountsTowardGoal,
            entityIdParam ? eq(pledgeAllocations.entityId, entityIdParam) : undefined,
          ),
        )
        .orderBy(desc(opportunitiesAndPledges.projectedCloseDate)),
    ]);

    // Sum at the API edge so the page header totals always agree with the
    // visible rows (and match the Dashboard tile numbers — same SQL).
    const sumStr = (rows: Array<{ subAmount: string | null }>, key: "subAmount" | "weightedAmount" = "subAmount") =>
      rows
        .reduce((acc, r) => acc + Number((r as Record<string, string | null>)[key] ?? 0), 0)
        .toFixed(2);

    // Partition the drill-down rows into the two parallel tracks. Loan capital
    // is never mixed into revenue, so each category gets its own totals + goal.
    const categoryBreakdown = (cat: FundraisingCategory) => {
      const received = receivedRows.filter((r) => r.category === cat);
      const open = openRows.filter((r) => r.category === cat);
      return {
        goal: goalByCategory[cat],
        received: {
          total: sumStr(received),
          rows: received,
        },
        openPipeline: {
          totalAsk: sumStr(open),
          totalWeighted: sumStr(
            open as Array<{ subAmount: string; weightedAmount: string }>,
            "weightedAmount",
          ),
          rows: open,
        },
      };
    };

    res.json({
      fiscalYear,
      revenue: categoryBreakdown("revenue"),
      loanCapital: categoryBreakdown("loan_capital"),
    });
  }),
);

// The records behind ONE fiscal year + track's progress-to-goal bar. Mirrors
// `fyMetricsFor` semantics exactly (same archived / countsTowardGoal /
// reimbursable-`direct` exclusions; committed = per-opp unpaid remainder of
// status='pledge'; weighted open = sub_amount × win_probability on status='open')
// so the per-bucket totals reconcile to the dashboard bar for the same FY +
// track + entity filter. Returns every contributing row tagged by bucket,
// ordered received → committed → open, amount descending within each.
router.get(
  "/fiscal-year-report/:fyId",
  asyncHandler(async (req, res) => {
    const fyId = String(req.params.fyId ?? "");
    if (!fyId) return notFound(res, "fiscal year");
    const category: FundraisingCategory = isFundraisingCategory(req.query.category)
      ? req.query.category
      : "revenue";
    const entityIds = parseEntityIdsParam(req.query.entityIds);
    const hasEntityFilter = entityIds.length > 0;

    const fyRow = await db
      .select({
        id: fiscalYears.id,
        startDate: sql<string>`${fiscalYears.startDate}::text`,
        endDate: sql<string>`${fiscalYears.endDate}::text`,
      })
      .from(fiscalYears)
      .where(eq(fiscalYears.id, fyId))
      .then((r) => r[0]);
    if (!fyRow) return notFound(res, "fiscal year");
    const endYear = Number(fyId.slice(2));
    const fiscalYear = {
      id: fyRow.id,
      label: `FY ${endYear}`,
      startDate: fyRow.startDate,
      endDate: fyRow.endDate,
    };

    // Track filter, one per source table. Revenue = "anything not loan" using
    // IS DISTINCT FROM so a null loan_or_grant still counts as revenue (mirrors
    // the giftCategorySql / oppCategorySql / goalCategorySql CASE expressions).
    const oppCatFilter =
      category === "loan_capital"
        ? sql`${opportunitiesAndPledges.loanOrGrant} = 'loan'`
        : sql`${opportunitiesAndPledges.loanOrGrant} IS DISTINCT FROM 'loan'`;
    const giftCatFilter =
      category === "loan_capital"
        ? sql`${giftsAndPayments.loanOrGrant} = 'loan'`
        : sql`${giftsAndPayments.loanOrGrant} IS DISTINCT FROM 'loan'`;
    const goalCatFilter =
      category === "loan_capital"
        ? sql`${fiscalYearEntityGoals.loanOrGrant} = 'loan'`
        : sql`${fiscalYearEntityGoals.loanOrGrant} IS DISTINCT FROM 'loan'`;

    // Per-opp pledged amount + win-prob for this FY+track (status='pledge'),
    // and the payments already booked against those pledges this FY. The
    // committed bucket is one row per pledge opp: remainder = pledged − paid
    // (clamped ≥ 0), exactly like fyMetricsFor's committed rollup.
    const pledgedPerOpp = db
      .select({
        oppId: sql<string>`${pledgeAllocations.pledgeOrOpportunityId}`.as("pledged_opp_id"),
        pledged: sql<string>`SUM(${pledgeAllocations.subAmount})`.as("pledged"),
        winProb: sql<string>`MAX(${opportunitiesAndPledges.winProbability})`.as("pledged_win_prob"),
      })
      .from(pledgeAllocations)
      .innerJoin(
        opportunitiesAndPledges,
        eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
      )
      .where(
        and(
          eq(opportunitiesAndPledges.status, "pledge"),
          eq(pledgeAllocations.grantYear, fyId),
          pledgeAllocCountsTowardGoal,
          oppCatFilter,
          hasEntityFilter ? inArray(pledgeAllocations.entityId, entityIds) : undefined,
        ),
      )
      .groupBy(pledgeAllocations.pledgeOrOpportunityId)
      .as("pledged_per_opp");

    const paidPerOpp = db
      .select({
        oppId: sql<string>`${giftsAndPayments.opportunityId}`.as("paid_opp_id"),
        paid: sql<string>`SUM(${giftAllocations.subAmount})`.as("paid"),
      })
      .from(giftAllocations)
      .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
      .where(
        and(
          eq(giftAllocations.grantYear, fyId),
          isNull(giftsAndPayments.archivedAt),
          eq(giftAllocations.countsTowardGoal, true),
          giftAllocCountsTowardGoal,
          hasEntityFilter ? inArray(giftAllocations.entityId, entityIds) : undefined,
        ),
      )
      .groupBy(giftsAndPayments.opportunityId)
      .as("paid_per_opp");

    const [receivedRaw, committedRaw, openRaw, goalRow] = await Promise.all([
      // Received = gift_allocations booked to this FY+track (cash in).
      db
        .select({
          allocationId: giftAllocations.id,
          subAmount: sql<string>`${giftAllocations.subAmount}::text`,
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
        })
        .from(giftAllocations)
        .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
        .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
        .where(
          and(
            eq(giftAllocations.grantYear, fyId),
            isNull(giftsAndPayments.archivedAt),
            eq(giftAllocations.countsTowardGoal, true),
            giftAllocCountsTowardGoal,
            giftCatFilter,
            hasEntityFilter ? inArray(giftAllocations.entityId, entityIds) : undefined,
          ),
        )
        .orderBy(desc(giftAllocations.subAmount)),
      // Committed = per-opp unpaid remainder of written pledges. Drop fully-paid
      // opps (remainder ≤ 0) — they contribute $0 so excluding them keeps the
      // totals identical while removing noise rows.
      db
        .select({
          opportunityId: opportunitiesAndPledges.id,
          opportunityName: opportunitiesAndPledges.name,
          opportunityStage: sql<string | null>`${opportunitiesAndPledges.stage}::text`,
          winProbability: sql<string | null>`${opportunitiesAndPledges.winProbability}::text`,
          projectedCloseDate: sql<string | null>`${opportunitiesAndPledges.projectedCloseDate}::text`,
          pledged: sql<string>`${pledgedPerOpp.pledged}::text`,
          paid: sql<string>`COALESCE(${paidPerOpp.paid}, 0)::text`,
          remainder: sql<string>`GREATEST(${pledgedPerOpp.pledged} - COALESCE(${paidPerOpp.paid}, 0), 0)::text`,
          weighted: sql<string>`(GREATEST(${pledgedPerOpp.pledged} - COALESCE(${paidPerOpp.paid}, 0), 0) * ${pledgedPerOpp.winProb})::text`,
          organizationId: opportunitiesAndPledges.organizationId,
          organizationName: organizations.name,
          householdId: opportunitiesAndPledges.householdId,
          householdName: households.name,
          individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
          individualGiverPersonName: personDisplayNameSql,
          organizationPriority: organizations.priority,
          individualGiverPersonPriority: people.priority,
        })
        .from(pledgedPerOpp)
        .innerJoin(opportunitiesAndPledges, eq(opportunitiesAndPledges.id, pledgedPerOpp.oppId))
        .leftJoin(paidPerOpp, eq(pledgedPerOpp.oppId, paidPerOpp.oppId))
        .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
        .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
        .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
        .where(sql`GREATEST(${pledgedPerOpp.pledged} - COALESCE(${paidPerOpp.paid}, 0), 0) > 0`)
        .orderBy(desc(sql`GREATEST(${pledgedPerOpp.pledged} - COALESCE(${paidPerOpp.paid}, 0), 0)`)),
      // Open = pledge_allocations on status='open' opps for this FY+track.
      db
        .select({
          allocationId: pledgeAllocations.id,
          subAmount: sql<string>`${pledgeAllocations.subAmount}::text`,
          weightedAmount: sql<string>`(${pledgeAllocations.subAmount} * ${opportunitiesAndPledges.winProbability})::text`,
          entityId: pledgeAllocations.entityId,
          intendedUsage: sql<string | null>`${pledgeAllocations.intendedUsage}::text`,
          fundableProjectId: pledgeAllocations.fundableProjectId,
          opportunityId: pledgeAllocations.pledgeOrOpportunityId,
          opportunityName: opportunitiesAndPledges.name,
          opportunityStage: sql<string | null>`${opportunitiesAndPledges.stage}::text`,
          winProbability: sql<string | null>`${opportunitiesAndPledges.winProbability}::text`,
          projectedCloseDate: sql<string | null>`${opportunitiesAndPledges.projectedCloseDate}::text`,
          organizationId: opportunitiesAndPledges.organizationId,
          organizationName: organizations.name,
          householdId: opportunitiesAndPledges.householdId,
          householdName: households.name,
          individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
          individualGiverPersonName: personDisplayNameSql,
          organizationPriority: organizations.priority,
          individualGiverPersonPriority: people.priority,
        })
        .from(pledgeAllocations)
        .innerJoin(
          opportunitiesAndPledges,
          eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
        )
        .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
        .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
        .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
        .where(
          and(
            eq(opportunitiesAndPledges.status, "open"),
            eq(pledgeAllocations.grantYear, fyId),
            pledgeAllocCountsTowardGoal,
            oppCatFilter,
            hasEntityFilter ? inArray(pledgeAllocations.entityId, entityIds) : undefined,
          ),
        )
        .orderBy(desc(pledgeAllocations.subAmount)),
      db
        .select({
          goal: sql<string | null>`NULLIF(SUM(${fiscalYearEntityGoals.goalAmount}), 0)::text`,
        })
        .from(fiscalYearEntityGoals)
        .where(
          and(
            eq(fiscalYearEntityGoals.fiscalYearId, fyId),
            goalCatFilter,
            hasEntityFilter ? inArray(fiscalYearEntityGoals.entityId, entityIds) : undefined,
          ),
        )
        .then((r) => r[0]),
    ]);

    const donorOf = <
      R extends {
        organizationId: string | null;
        organizationName: string | null;
        householdId: string | null;
        householdName: string | null;
        individualGiverPersonId: string | null;
        individualGiverPersonName: string | null;
        organizationPriority: unknown;
        individualGiverPersonPriority: unknown;
      },
    >(
      r: R,
    ) => ({
      organizationId: r.organizationId,
      organizationName: r.organizationName,
      householdId: r.householdId,
      householdName: r.householdName,
      individualGiverPersonId: r.individualGiverPersonId,
      individualGiverPersonName: r.individualGiverPersonName,
      organizationPriority: r.organizationPriority,
      individualGiverPersonPriority: r.individualGiverPersonPriority,
    });

    const receivedRows = receivedRaw.map((r) => ({
      rowId: `received:${r.allocationId}`,
      bucket: "received" as const,
      amount: r.subAmount,
      weightedAmount: null,
      category,
      entityId: r.entityId,
      intendedUsage: r.intendedUsage,
      displayUsage: r.displayUsage,
      fundableProjectId: r.fundableProjectId,
      giftId: r.giftId,
      giftType: r.giftType,
      dateReceived: r.dateReceived,
      opportunityId: null,
      opportunityName: null,
      opportunityStage: null,
      winProbability: null,
      projectedCloseDate: null,
      pledgedAmount: null,
      paidAmount: null,
      ...donorOf(r),
    }));

    const committedRows = committedRaw.map((r) => ({
      rowId: `committed:${r.opportunityId}`,
      bucket: "committed" as const,
      amount: r.remainder,
      weightedAmount: r.weighted,
      category,
      entityId: null,
      intendedUsage: null,
      displayUsage: null,
      fundableProjectId: null,
      giftId: null,
      giftType: null,
      dateReceived: null,
      opportunityId: r.opportunityId,
      opportunityName: r.opportunityName,
      opportunityStage: r.opportunityStage,
      winProbability: r.winProbability,
      projectedCloseDate: r.projectedCloseDate,
      pledgedAmount: r.pledged,
      paidAmount: r.paid,
      ...donorOf(r),
    }));

    const openRows = openRaw.map((r) => ({
      rowId: `open:${r.allocationId}`,
      bucket: "open" as const,
      amount: r.subAmount,
      weightedAmount: r.weightedAmount,
      category,
      entityId: r.entityId,
      intendedUsage: r.intendedUsage,
      displayUsage: null,
      fundableProjectId: r.fundableProjectId,
      giftId: null,
      giftType: null,
      dateReceived: null,
      opportunityId: r.opportunityId,
      opportunityName: r.opportunityName,
      opportunityStage: r.opportunityStage,
      winProbability: r.winProbability,
      projectedCloseDate: r.projectedCloseDate,
      pledgedAmount: null,
      paidAmount: null,
      ...donorOf(r),
    }));

    // Sum at the API edge so the header totals always agree with the visible
    // rows. Each per-row amount/weighted is already SQL-computed, so summing
    // them reproduces fyMetricsFor's SUM(...) and reconciles to the dashboard.
    const sumStr = (vals: Array<string | null>) =>
      vals.reduce((acc, v) => acc + Number(v ?? 0), 0).toFixed(2);
    const received = sumStr(receivedRows.map((r) => r.amount));
    const committed = sumStr(committedRows.map((r) => r.amount));
    const committedWeighted = sumStr(committedRows.map((r) => r.weightedAmount));
    const openAsk = sumStr(openRows.map((r) => r.amount));
    const openWeighted = sumStr(openRows.map((r) => r.weightedAmount));
    const weightedProjection = (
      Number(received) +
      Number(committedWeighted) +
      Number(openWeighted)
    ).toFixed(2);

    res.json({
      fiscalYear,
      category,
      totals: {
        received,
        committed,
        committedWeighted,
        openAsk,
        openWeighted,
        weightedProjection,
        goal: goalRow?.goal ?? null,
      },
      rows: [...receivedRows, ...committedRows, ...openRows],
    });
  }),
);

router.get(
  "/projections-by-fy-entity",
  asyncHandler(async (req, res) => {
    // Accept entityId as a comma-separated list or a repeated query param.
    // Mirrors the orval `style: form, explode: false` serialization used
    // by every other multi-value filter in this codebase.
    const raw = req.query.entityId;
    const entityIds: string[] = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === "string" && raw.length > 0
        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const baseFilters = [
      eq(opportunitiesAndPledges.status, "open"),
      inArray(pledgeAllocations.status, [
        "working",
        "committed",
        "committed_with_conditions",
      ]),
      pledgeAllocCountsTowardGoal,
    ];
    if (entityIds.length > 0) {
      baseFilters.push(inArray(pledgeAllocations.entityId, entityIds));
    }
    const rows = await db
      .select({
        grantYear: pledgeAllocations.grantYear,
        entityId: pledgeAllocations.entityId,
        category: oppCategorySql,
        allocationCount: count(),
        totalSubAmount: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount}), 0)::text`,
        expected: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount} * ${opportunitiesAndPledges.winProbability}), 0)::text`,
      })
      .from(pledgeAllocations)
      .innerJoin(
        opportunitiesAndPledges,
        eq(
          pledgeAllocations.pledgeOrOpportunityId,
          opportunitiesAndPledges.id,
        ),
      )
      .where(and(...baseFilters))
      .groupBy(
        pledgeAllocations.grantYear,
        pledgeAllocations.entityId,
        opportunitiesAndPledges.loanOrGrant,
      );

    res.json({
      rows: rows.map((r) => ({
        grantYear: r.grantYear,
        entityId: r.entityId,
        category: isFundraisingCategory(r.category) ? r.category : "revenue",
        allocationCount: Number(r.allocationCount),
        totalSubAmount: r.totalSubAmount,
        expected: r.expected,
      })),
    });
  }),
);

export default router;
