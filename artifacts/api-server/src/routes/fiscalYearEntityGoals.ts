import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { fiscalYearEntityGoals, fiscalYears, entities } from "@workspace/db/schema";
import { and, asc, eq, type SQL } from "drizzle-orm";
import {
  ListFiscalYearEntityGoalsQueryParams,
  UpsertFiscalYearEntityGoalBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { asyncHandler, notFound, parseOrBadRequest } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

// Decimal string (numeric(14,2)). Allows optional minus, integer part,
// optional fractional part. Mirrors what the DB will accept without raising
// a `numeric` cast error.
const DECIMAL_RE = /^-?\d+(\.\d{1,2})?$/;

router.get(
  "/fiscal-year-entity-goals",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListFiscalYearEntityGoalsQueryParams, req.query, res);
    if (!q) return;
    const filters: SQL[] = [];
    if (q.fyId) filters.push(eq(fiscalYearEntityGoals.fiscalYearId, q.fyId));
    if (q.entityId) filters.push(eq(fiscalYearEntityGoals.entityId, q.entityId));
    if (q.category) filters.push(eq(fiscalYearEntityGoals.category, q.category));
    const where = filters.length ? and(...filters) : undefined;
    const rows = await db
      .select()
      .from(fiscalYearEntityGoals)
      .where(where)
      .orderBy(
        asc(fiscalYearEntityGoals.fiscalYearId),
        asc(fiscalYearEntityGoals.entityId),
        asc(fiscalYearEntityGoals.category),
      );
    res.json(rows);
  }),
);

// Fundraising category path param — defaults to 'revenue' so older clients
// hitting the legacy two-segment path still resolve to the revenue track.
function parseCategoryParam(raw: unknown): "revenue" | "loan_capital" | null {
  if (raw === undefined) return "revenue";
  if (raw === "revenue" || raw === "loan_capital") return raw;
  return null;
}

router.put(
  "/fiscal-year-entity-goals/:fyId/:entityId/:category",
  asyncHandler(async (req, res) => {
    // Setting fundraising goals is an admin-only action — these numbers drive
    // every analytics rollup, so a regular team member must not change them.
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(UpsertFiscalYearEntityGoalBody, req.body, res);
    if (!body) return;
    if (!DECIMAL_RE.test(body.goalAmount)) {
      res.status(400).json({
        error: "validation_error",
        message: "goalAmount must be a decimal string like '4000000' or '1000000.50' (no commas).",
      });
      return;
    }
    const category = parseCategoryParam(req.params.category);
    if (!category) {
      res.status(400).json({
        error: "validation_error",
        message: "category must be 'revenue' or 'loan_capital'.",
      });
      return;
    }
    const fyId = String(req.params.fyId);
    const entityId = String(req.params.entityId);
    // Validate FKs up front so we can return a clean 404 instead of a 500 from
    // the FK constraint. Both lookups are tiny — entities + FYs are small,
    // bounded sets.
    const [fy, ent] = await Promise.all([
      db.select({ id: fiscalYears.id }).from(fiscalYears).where(eq(fiscalYears.id, fyId)).then((r) => r[0]),
      db.select({ id: entities.id }).from(entities).where(eq(entities.id, entityId)).then((r) => r[0]),
    ]);
    if (!fy) return notFound(res, `fiscal year '${fyId}'`);
    if (!ent) return notFound(res, `entity '${entityId}'`);

    const [row] = await db
      .insert(fiscalYearEntityGoals)
      .values({ fiscalYearId: fyId, entityId, category, goalAmount: body.goalAmount })
      .onConflictDoUpdate({
        target: [
          fiscalYearEntityGoals.fiscalYearId,
          fiscalYearEntityGoals.entityId,
          fiscalYearEntityGoals.category,
        ],
        set: { goalAmount: body.goalAmount, updatedAt: new Date() },
      })
      .returning();
    res.json(row);
  }),
);

router.delete(
  "/fiscal-year-entity-goals/:fyId/:entityId/:category",
  asyncHandler(async (req, res) => {
    // Deleting a goal is admin-only for the same reason as the upsert above.
    if (!requireAdmin(req, res)) return;
    const category = parseCategoryParam(req.params.category);
    if (!category) {
      res.status(400).json({
        error: "validation_error",
        message: "category must be 'revenue' or 'loan_capital'.",
      });
      return;
    }
    await db
      .delete(fiscalYearEntityGoals)
      .where(
        and(
          eq(fiscalYearEntityGoals.fiscalYearId, String(req.params.fyId)),
          eq(fiscalYearEntityGoals.entityId, String(req.params.entityId)),
          eq(fiscalYearEntityGoals.category, category),
        ),
      );
    res.status(204).end();
  }),
);

export default router;
