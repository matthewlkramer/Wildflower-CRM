import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { calendarEvents, notes } from "@workspace/db/schema";
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

async function canLinkCalendarEvent(eventId: string) {
  return db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(
      and(eq(calendarEvents.id, eventId), eq(calendarEvents.isPrivate, false)),
    )
    .then((rows) => rows[0]);
}

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
    if (q.calendarEventId) {
      filters.push(sql`exists (
        select 1
        from calendar_events linked_event
        join calendar_events requested_event
          on requested_event.gcal_event_id = linked_event.gcal_event_id
        where linked_event.id = ${notes.calendarEventId}
          and requested_event.id = ${q.calendarEventId}
      )`);
    }
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
    if (
      body.calendarEventId &&
      !(await canLinkCalendarEvent(body.calendarEventId))
    ) {
      res.status(400).json({
        error: "validation_error",
        message: "The selected meeting was not found or is private.",
      });
      return;
    }
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
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    if (
      typeof body.calendarEventId === "string" &&
      !(await canLinkCalendarEvent(body.calendarEventId))
    ) {
      res.status(400).json({
        error: "validation_error",
        message: "The selected meeting was not found or is private.",
      });
      return;
    }
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
