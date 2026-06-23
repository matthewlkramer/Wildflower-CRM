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
} from "@workspace/db/schema";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound } from "../lib/helpers";

// Person display name matches the rest of the API: COALESCE(full_name,
// trim(first||' '||last)). Kept inline (not extracted) because callers
// pick different parent-table columns alongside it.
const personDisplayNameSql = sql<string | null>`
  COALESCE(
    NULLIF(TRIM(${people.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
  )
`;

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
  received: string;
  goal: string | null;
};

function emptyCategoryMetrics(): CategoryMetrics {
  return {
    openPipelineAsk: "0",
    openPipelineWeighted: "0",
    committed: "0",
    received: "0",
    goal: null,
  };
}

function isFundraisingCategory(v: unknown): v is FundraisingCategory {
  return v === "revenue" || v === "loan_capital";
}

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
    })
    .from(pledgeAllocations)
    .innerJoin(
      opportunitiesAndPledges,
      eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
    )
    .where(
      and(
        eq(opportunitiesAndPledges.status, "pledge"),
        eq(pledgeAllocations.grantYear, fy.id),
        hasEntityFilter ? inArray(pledgeAllocations.entityId, entityIds!) : undefined,
      ),
    )
    .groupBy(pledgeAllocations.pledgeOrOpportunityId, opportunitiesAndPledges.loanOrGrant)
    .as("pledged_per_opp");

  // Payments already booked against those pledges, scoped to the same FY +
  // entities as `received`, so we only ever subtract money `received` counts.
  const paidPerOpp = db
    .select({
      oppId: sql<string>`${giftsAndPayments.paymentOnPledgeId}`.as("paid_opp_id"),
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
        // Gifts flagged out of goal tracking neither add to `received` nor
        // pay down `committed`, so the goal numbers stay internally consistent.
        eq(giftsAndPayments.countsTowardGoal, true),
        hasEntityFilter ? inArray(giftAllocations.entityId, entityIds!) : undefined,
      ),
    )
    .groupBy(giftsAndPayments.paymentOnPledgeId)
    .as("paid_per_opp");

  const [openRows, committedRows, receivedRows, goalRows] = await Promise.all([
    db
      .select({
        category: oppCategorySql,
        ask: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount}), 0)::text`,
        weighted: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount} * COALESCE(${opportunitiesAndPledges.winProbability}, 1)), 0)::text`,
      })
      .from(pledgeAllocations)
      .innerJoin(
        opportunitiesAndPledges,
        eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
      )
      .where(
        and(
          eq(opportunitiesAndPledges.status, "open"),
          eq(pledgeAllocations.grantYear, fy.id),
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
          eq(giftsAndPayments.countsTowardGoal, true),
          hasEntityFilter
            ? inArray(giftAllocations.entityId, entityIds!)
            : undefined,
        ),
      )
      .groupBy(giftCategorySql),
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
  }
  for (const r of receivedRows) {
    if (!isFundraisingCategory(r.category)) continue;
    byCategory[r.category].received = r.v;
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
      // Pledges-page count: was_pledge=true OR stage ∈ pledge stages.
      // Mirrors the pledgeView=pledges filter in the opps list route.
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(
          sql`(${opportunitiesAndPledges.wasPledge} = true OR ${opportunitiesAndPledges.stage} IN ('conditional_commitment','written_commitment'))`,
        ),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .where(isNull(giftsAndPayments.archivedAt)),
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
          giftType: sql<string | null>`${giftsAndPayments.type}::text`,
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
            // Mirror the dashboard tile: archived gifts and gifts flagged out
            // of goal tracking don't count, so the drill-down rows (and their
            // API-edge total) stay in agreement with the tile.
            isNull(giftsAndPayments.archivedAt),
            eq(giftsAndPayments.countsTowardGoal, true),
            entityIdParam ? eq(giftAllocations.entityId, entityIdParam) : undefined,
          ),
        )
        .orderBy(desc(giftsAndPayments.dateReceived)),
      db
        .select({
          allocationId: pledgeAllocations.id,
          subAmount: sql<string>`${pledgeAllocations.subAmount}::text`,
          weightedAmount: sql<string>`(${pledgeAllocations.subAmount} * COALESCE(${opportunitiesAndPledges.winProbability}, 1))::text`,
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
        expected: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount} * COALESCE(${opportunitiesAndPledges.winProbability}, 1)), 0)::text`,
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
