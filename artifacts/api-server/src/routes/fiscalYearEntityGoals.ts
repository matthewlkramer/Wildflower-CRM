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

// Goal category token → { legacy `category` PK value, authoritative
// `loan_or_grant` }. A002 READ CUTOVER: reads now filter on the authoritative
// `loan_or_grant` flag, but the table PK is still the legacy `category`, which
// the upsert/delete keep writing 1:1 (dual-write). Accepts BOTH token families
// during the transition:
//   - new:    'loan' | 'grant'
//   - legacy: 'loan_capital' | 'revenue'
// Returns null for an unknown token.
function normalizeGoalCategory(
  raw: string,
): { category: "revenue" | "loan_capital"; loanOrGrant: "loan" | "grant" } | null {
  if (raw === "revenue" || raw === "grant") return { category: "revenue", loanOrGrant: "grant" };
  if (raw === "loan_capital" || raw === "loan") return { category: "loan_capital", loanOrGrant: "loan" };
  return null;
}

// Path-param variant for the PUT/DELETE `:category` segment. An absent segment
// defaults to the revenue/grant track so older clients hitting the legacy
// two-segment path still resolve.
function parseCategoryParam(
  raw: unknown,
): { category: "revenue" | "loan_capital"; loanOrGrant: "loan" | "grant" } | null {
  if (raw === undefined) return { category: "revenue", loanOrGrant: "grant" };
  return typeof raw === "string" ? normalizeGoalCategory(raw) : null;
}

router.get(
  "/fiscal-year-entity-goals",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListFiscalYearEntityGoalsQueryParams, req.query, res);
    if (!q) return;
    const filters: SQL[] = [];
    if (q.fyId) filters.push(eq(fiscalYearEntityGoals.fiscalYearId, q.fyId));
    if (q.entityId) filters.push(eq(fiscalYearEntityGoals.entityId, q.entityId));
    // Filter on the authoritative loan_or_grant flag (A002 read cutover),
    // accepting both the new loan|grant and the legacy revenue|loan_capital
    // tokens.
    if (q.category) {
      const norm = normalizeGoalCategory(q.category);
      if (!norm) {
        res.status(400).json({
          error: "validation_error",
          message: "category must be one of 'revenue', 'loan_capital', 'loan', 'grant'.",
        });
        return;
      }
      filters.push(eq(fiscalYearEntityGoals.loanOrGrant, norm.loanOrGrant));
    }
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
    const parsed = parseCategoryParam(req.params.category);
    if (!parsed) {
      res.status(400).json({
        error: "validation_error",
        message: "category must be one of 'revenue', 'loan_capital', 'loan', 'grant'.",
      });
      return;
    }
    const { category, loanOrGrant } = parsed;
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

    // The table PK is still the legacy `category`; dual-write the authoritative
    // loan_or_grant alongside it (1:1) so reads can flip to loan_or_grant.
    const [row] = await db
      .insert(fiscalYearEntityGoals)
      .values({ fiscalYearId: fyId, entityId, category, goalAmount: body.goalAmount, loanOrGrant })
      .onConflictDoUpdate({
        target: [
          fiscalYearEntityGoals.fiscalYearId,
          fiscalYearEntityGoals.entityId,
          fiscalYearEntityGoals.category,
        ],
        set: { goalAmount: body.goalAmount, loanOrGrant, updatedAt: new Date() },
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
    const parsed = parseCategoryParam(req.params.category);
    if (!parsed) {
      res.status(400).json({
        error: "validation_error",
        message: "category must be one of 'revenue', 'loan_capital', 'loan', 'grant'.",
      });
      return;
    }
    // Delete by the legacy PK `category` AND the authoritative loan_or_grant
    // (1:1 aligned) — defensive: if they ever drift, delete nothing rather than
    // the wrong row.
    await db
      .delete(fiscalYearEntityGoals)
      .where(
        and(
          eq(fiscalYearEntityGoals.fiscalYearId, String(req.params.fyId)),
          eq(fiscalYearEntityGoals.entityId, String(req.params.entityId)),
          eq(fiscalYearEntityGoals.category, parsed.category),
          eq(fiscalYearEntityGoals.loanOrGrant, parsed.loanOrGrant),
        ),
      );
    res.status(204).end();
  }),
);

export default router;
