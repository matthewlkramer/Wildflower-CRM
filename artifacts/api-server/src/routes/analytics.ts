import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  people,
  funders,
  households,
  organizations,
  opportunitiesAndPledges,
  pledgeAllocations,
  giftsAndPayments,
  giftAllocations,
  fiscalYears,
} from "@workspace/db/schema";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";

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
async function fyMetricsFor(fy: FyDescriptor) {
  const [[openRow], [receivedRow], [goalRow]] = await Promise.all([
    db
      .select({
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
        ),
      ),
    db
      .select({
        v: sql<string>`COALESCE(SUM(${giftAllocations.subAmount}), 0)::text`,
      })
      .from(giftAllocations)
      .where(eq(giftAllocations.grantYear, fy.id)),
    db
      .select({
        goal: sql<string | null>`${fiscalYears.goalAmount}::text`,
      })
      .from(fiscalYears)
      .where(eq(fiscalYears.id, fy.id)),
  ]);

  return {
    fiscalYear: fy,
    openPipelineAsk: openRow?.ask ?? "0",
    openPipelineWeighted: openRow?.weighted ?? "0",
    received: receivedRow?.v ?? "0",
    goal: goalRow?.goal ?? null,
  };
}

router.get(
  "/dashboard-summary",
  asyncHandler(async (_req, res) => {
    const currentFy = computeCurrentFiscalYear();
    const nextFy = fyFromEndYear(Number(currentFy.id.slice(2)) + 1);

    const [
      [{ value: peopleCt }],
      [{ value: fundersCt }],
      [{ value: householdsCt }],
      [{ value: orgsCt }],
      [{ value: oppsCt }],
      [{ value: openCt }],
      [{ value: wonCt }],
      [{ value: giftsCt }],
      currentFyMetrics,
      nextFyMetrics,
    ] = await Promise.all([
      db.select({ value: count() }).from(people),
      db.select({ value: count() }).from(funders),
      db.select({ value: count() }).from(households),
      db.select({ value: count() }).from(organizations),
      db.select({ value: count() }).from(opportunitiesAndPledges),
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.status, "open")),
      db
        .select({ value: count() })
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.status, "won")),
      db.select({ value: count() }).from(giftsAndPayments),
      fyMetricsFor(currentFy),
      fyMetricsFor(nextFy),
    ]);

    res.json({
      counts: {
        people: Number(peopleCt),
        funders: Number(fundersCt),
        households: Number(householdsCt),
        organizations: Number(orgsCt),
        opportunities: Number(oppsCt),
        openOpportunities: Number(openCt),
        wonPledges: Number(wonCt),
        gifts: Number(giftsCt),
      },
      currentFiscalYear: currentFy,
      byFiscalYear: [currentFyMetrics, nextFyMetrics],
    });
  }),
);

router.get(
  "/projections-by-fy-entity",
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        grantYear: pledgeAllocations.grantYear,
        entityId: pledgeAllocations.entityId,
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
      .where(
        and(
          eq(opportunitiesAndPledges.status, "open"),
          inArray(pledgeAllocations.status, [
            "working",
            "committed",
            "committed_with_conditions",
          ]),
        ),
      )
      .groupBy(pledgeAllocations.grantYear, pledgeAllocations.entityId);

    res.json({
      rows: rows.map((r) => ({
        grantYear: r.grantYear,
        entityId: r.entityId,
        allocationCount: Number(r.allocationCount),
        totalSubAmount: r.totalSubAmount,
        expected: r.expected,
      })),
    });
  }),
);

export default router;
