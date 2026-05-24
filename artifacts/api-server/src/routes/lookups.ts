import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { fundableProjects, fiscalYears } from "@workspace/db/schema";
import { asc } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";

// NOTE: /entities (GET/POST/PATCH) and /fiscal-year-entity-goals routes live
// in their own files (entities.ts, fiscalYearEntityGoals.ts). This file is now
// just the remaining read-only lookups (fundable-projects, fiscal-years).
const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/fundable-projects",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(fundableProjects).orderBy(asc(fundableProjects.name));
    res.json(rows);
  }),
);

router.get(
  "/fiscal-years",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(fiscalYears).orderBy(asc(fiscalYears.id));
    res.json(rows);
  }),
);

export default router;
