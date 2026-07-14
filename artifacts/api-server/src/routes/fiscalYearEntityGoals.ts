import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { fiscalYearEntityGoals, fiscalYears, entities } from "@workspace/db/schema";
import { and, asc, eq, getTableColumns, type SQL } from "drizzle-orm";
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

// Goal category token → authoritative `loan_or_grant`. The legacy `category`
// column is @deprecated (frozen, never written/read); the table PK is
// (fiscal_year_id, entity_id, loan_or_grant). Accepts BOTH token families so
// older clients keep working:
//   - new:    'loan' | 'grant'
//   - legacy: 'loan_capital' | 'revenue'
// Returns null for an unknown token.
function normalizeGoalCategory(raw: string): "loan" | "grant" | null {
  if (raw === "revenue" || raw === "grant") return "grant";
  if (raw === "loan_capital" || raw === "loan") return "loan";
  return null;
}

// Path-param variant for the PUT/DELETE `:category` segment. An absent segment
// defaults to the revenue/grant track so older clients hitting the legacy
// two-segment path still resolve.
function parseCategoryParam(raw: unknown): "loan" | "grant" | null {
  if (raw === undefined) return "grant";
  return typeof raw === "string" ? normalizeGoalCategory(raw) : null;
}

// Response projection: every column EXCEPT the @deprecated `category`, which
// must never leak to clients (responses are plain res.json — no Zod stripping).
const { category: _deprecatedCategory, ...goalResponseColumns } =
  getTableColumns(fiscalYearEntityGoals);

router.get(
  "/fiscal-year-entity-goals",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListFiscalYearEntityGoalsQueryParams, req.query, res);
    if (!q) return;
    const filters: SQL[] = [];
    if (q.fyId) filters.push(eq(fiscalYearEntityGoals.fiscalYearId, q.fyId));
    if (q.entityId) filters.push(eq(fiscalYearEntityGoals.entityId, q.entityId));
    // Filter on the authoritative loan_or_grant flag, accepting both the new
    // loan|grant and the legacy revenue|loan_capital tokens.
    if (q.category) {
      const norm = normalizeGoalCategory(q.category);
      if (!norm) {
        res.status(400).json({
          error: "validation_error",
          message: "category must be one of 'revenue', 'loan_capital', 'loan', 'grant'.",
        });
        return;
      }
      filters.push(eq(fiscalYearEntityGoals.loanOrGrant, norm));
    }
    const where = filters.length ? and(...filters) : undefined;
    const rows = await db
      .select(goalResponseColumns)
      .from(fiscalYearEntityGoals)
      .where(where)
      .orderBy(
        asc(fiscalYearEntityGoals.fiscalYearId),
        asc(fiscalYearEntityGoals.entityId),
        asc(fiscalYearEntityGoals.loanOrGrant),
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
    const loanOrGrant = parseCategoryParam(req.params.category);
    if (!loanOrGrant) {
      res.status(400).json({
        error: "validation_error",
        message: "category must be one of 'revenue', 'loan_capital', 'loan', 'grant'.",
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

    // Upsert on the authoritative PK (fy, entity, loan_or_grant). The legacy
    // `category` column is frozen — never written; new rows keep its default.
    const [row] = await db
      .insert(fiscalYearEntityGoals)
      .values({ fiscalYearId: fyId, entityId, goalAmount: body.goalAmount, loanOrGrant })
      .onConflictDoUpdate({
        target: [
          fiscalYearEntityGoals.fiscalYearId,
          fiscalYearEntityGoals.entityId,
          fiscalYearEntityGoals.loanOrGrant,
        ],
        set: { goalAmount: body.goalAmount, updatedAt: new Date() },
      })
      .returning(goalResponseColumns);
    res.json(row);
  }),
);

router.delete(
  "/fiscal-year-entity-goals/:fyId/:entityId/:category",
  asyncHandler(async (req, res) => {
    // Deleting a goal is admin-only for the same reason as the upsert above.
    if (!requireAdmin(req, res)) return;
    const loanOrGrant = parseCategoryParam(req.params.category);
    if (!loanOrGrant) {
      res.status(400).json({
        error: "validation_error",
        message: "category must be one of 'revenue', 'loan_capital', 'loan', 'grant'.",
      });
      return;
    }
    // Delete by the authoritative PK (fy, entity, loan_or_grant).
    await db
      .delete(fiscalYearEntityGoals)
      .where(
        and(
          eq(fiscalYearEntityGoals.fiscalYearId, String(req.params.fyId)),
          eq(fiscalYearEntityGoals.entityId, String(req.params.entityId)),
          eq(fiscalYearEntityGoals.loanOrGrant, loanOrGrant),
        ),
      );
    res.status(204).end();
  }),
);

export default router;
