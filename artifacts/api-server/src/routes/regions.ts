import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { regions } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, sql, type SQL } from "drizzle-orm";
import { ListRegionsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/regions",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListRegionsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.type) filters.push(eq(regions.type, q.type));
    if (q.search) filters.push(ilike(regions.name, `%${q.search}%`));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(regions).where(where).orderBy(asc(regions.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(regions).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/regions/:id",
  asyncHandler(async (req, res) => {
    const row = await db.select().from(regions).where(eq(regions.id, paramId(req))).then((r) => r[0]);
    if (!row) return notFound(res, "region");
    res.json(row);
  }),
);

export default router;
