import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { schools } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, type SQL } from "drizzle-orm";
import { ListSchoolsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/schools",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListSchoolsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.status) filters.push(eq(schools.status, q.status));
    if (q.governanceModel) filters.push(eq(schools.governanceModel, q.governanceModel));
    if (q.search) filters.push(ilike(schools.name, `%${q.search}%`));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(schools).where(where).orderBy(asc(schools.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(schools).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/schools/:id",
  asyncHandler(async (req, res) => {
    const row = await db.select().from(schools).where(eq(schools.id, paramId(req))).then((r) => r[0]);
    if (!row) return notFound(res, "school");
    res.json(row);
  }),
);

export default router;
