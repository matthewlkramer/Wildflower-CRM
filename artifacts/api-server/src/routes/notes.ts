import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { notes } from "@workspace/db/schema";
import { and, desc, count, eq, ilike, sql, type SQL } from "drizzle-orm";
import {
  ListNotesQueryParams,
  CreateNoteBody,
  UpdateNoteBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/notes",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListNotesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) {
      filters.push(ilike(notes.body, `%${q.search}%`));
    }
    if (q.authorUserId) filters.push(eq(notes.authorUserId, q.authorUserId));
    if (q.personId) filters.push(sql`${notes.personIds} @> ARRAY[${q.personId}]::text[]`);
    if (q.organizationId) filters.push(sql`${notes.organizationIds} @> ARRAY[${q.organizationId}]::text[]`);
    if (q.householdId) filters.push(sql`${notes.householdIds} @> ARRAY[${q.householdId}]::text[]`);
    if (q.opportunityId) filters.push(sql`${notes.opportunityIds} @> ARRAY[${q.opportunityId}]::text[]`);
    if (q.giftId) filters.push(sql`${notes.giftIds} @> ARRAY[${q.giftId}]::text[]`);
    if (q.mentionUserId) filters.push(sql`${notes.mentionUserIds} @> ARRAY[${q.mentionUserId}]::text[]`);
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(notes)
        .where(where)
        .orderBy(desc(notes.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(notes).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/notes/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(notes)
      .where(eq(notes.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "note");
    res.json(row);
  }),
);

router.post(
  "/notes",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateNoteBody, req.body, res);
    if (!body) return;
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const [row] = await db
      .insert(notes)
      .values({
        id: newId(),
        authorUserId: user.id,
        ...body,
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/notes/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateNoteBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(notes)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(notes.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "note");
    res.json(row);
  }),
);

router.delete(
  "/notes/:id",
  asyncHandler(async (req, res) => {
    await db.delete(notes).where(eq(notes.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
