import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { schools } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, type SQL } from "drizzle-orm";
import { ListSchoolsQueryParams, UpdateSchoolBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { activeOnlyUnlessAdmin, archiveOne, unarchiveOne } from "../lib/archive";

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
    const archivedFilter = activeOnlyUnlessAdmin(req, schools.archivedAt);
    if (archivedFilter) filters.push(archivedFilter);
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

// Minimal PATCH for inline editing of simple scalar/enum fields only. Schools
// are otherwise synced from Airtable; relational/array fields are edited on the
// detail page (or upstream), not inline.
router.patch(
  "/schools/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateSchoolBody, req.body, res);
    if (!body) return;
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: "validation_error", message: "Empty update body." });
      return;
    }
    const [row] = await db
      .update(schools)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schools.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "school");
    res.json(row);
  }),
);

router.post(
  "/schools/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "school", table: schools });
  }),
);

router.post(
  "/schools/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "school", table: schools });
  }),
);

export default router;
