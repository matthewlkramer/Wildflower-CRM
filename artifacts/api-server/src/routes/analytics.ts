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
} from "@workspace/db/schema";
import { and, between, count, eq, inArray, sql } from "drizzle-orm";
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

function computeCurrentFiscalYear(now: Date = new Date()): {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
} {
  const parts = FY_DATE_PARTS.formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value); // 1-12
  const fyEndYear = m >= 7 ? y + 1 : y;
  const fyStartYear = fyEndYear - 1;
  return {
    id: `fy${fyEndYear}`,
    label: `FY ${fyEndYear}`,
    startDate: `${fyStartYear}-07-01`,
    endDate: `${fyEndYear}-06-30`,
  };
}

router.get(
  "/dashboard-summary",
  asyncHandler(async (_req, res) => {
    const fy = computeCurrentFiscalYear();

    const [
      [{ value: peopleCt }],
      [{ value: fundersCt }],
      [{ value: householdsCt }],
      [{ value: orgsCt }],
      [{ value: oppsCt }],
      [{ value: openCt }],
      [{ value: wonCt }],
      [{ value: giftsCt }],
      [openMoney],
      [awardedFyRow],
      [receivedFyRow],
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
      db
        .select({
          ask: sql<string>`COALESCE(SUM(${opportunitiesAndPledges.askAmount}), 0)::text`,
          expected: sql<string>`COALESCE(SUM(${opportunitiesAndPledges.askAmount} * COALESCE(${opportunitiesAndPledges.winProbability}, 1)), 0)::text`,
        })
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.status, "open")),
      db
        .select({
          v: sql<string>`COALESCE(SUM(${opportunitiesAndPledges.awardedAmount}), 0)::text`,
        })
        .from(opportunitiesAndPledges)
        .where(
          and(
            eq(opportunitiesAndPledges.status, "won"),
            between(
              opportunitiesAndPledges.actualCompletionDate,
              fy.startDate,
              fy.endDate,
            ),
          ),
        ),
      // "Received for FY<n>" is grant-year-attributed at the allocation
      // level, not by gift receipt date and not by the parent gift's
      // grant_year either: a single check can be split across multiple
      // fiscal years on gift_allocations.sub_amount with per-row
      // grant_year slugs. SCHEMA.md guarantees every gift carries at
      // least one gift_allocations row (synthesized 1:1 when no explicit
      // allocations exist), so summing allocations is exhaustive and
      // doesn't double-count.
      db
        .select({
          v: sql<string>`COALESCE(SUM(${giftAllocations.subAmount}), 0)::text`,
        })
        .from(giftAllocations)
        .where(eq(giftAllocations.grantYear, fy.id)),
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
      money: {
        openPipelineAsk: openMoney?.ask ?? "0",
        openPipelineExpected: openMoney?.expected ?? "0",
        awardedCurrentFy: awardedFyRow?.v ?? "0",
        receivedCurrentFy: receivedFyRow?.v ?? "0",
      },
      currentFiscalYear: fy,
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
