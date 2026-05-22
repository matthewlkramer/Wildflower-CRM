import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { entities, fundableProjects, fiscalYears } from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/entities",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(entities).orderBy(asc(entities.name));
    res.json(rows);
  }),
);
router.get(
  "/entities/:id",
  asyncHandler(async (req, res) => {
    const row = await db.select().from(entities).where(eq(entities.id, paramId(req))).then((r) => r[0]);
    if (!row) return notFound(res, "entity");
    res.json(row);
  }),
);

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
