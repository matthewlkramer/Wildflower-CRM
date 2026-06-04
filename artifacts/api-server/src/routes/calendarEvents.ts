import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { calendarEvents } from "@workspace/db/schema";
import { and, asc, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import {
  ListCalendarEventsQueryParams,
  UpdateCalendarEventPrivacyBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";

/**
 * Read-only surface over the synced Google Calendar events. Same
 * privacy contract as email_messages: a row is visible to the
 * caller iff `is_private = false` OR `calendar_user_id = caller.id`.
 * Only the calendar owner can flip the privacy flag.
 */
const router: IRouter = Router();
router.use(requireAuth);

function visibleToCaller(callerId: string): SQL {
  return or(
    eq(calendarEvents.isPrivate, false),
    eq(calendarEvents.calendarUserId, callerId),
  )!;
}

router.get(
  "/calendar-events",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const q = parseOrBadRequest(ListCalendarEventsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [visibleToCaller(user.id)];
    if (q.search) {
      const term = `%${q.search}%`;
      const orClause = or(
        ilike(calendarEvents.summary, term),
        ilike(calendarEvents.description, term),
        ilike(calendarEvents.location, term),
      );
      if (orClause) filters.push(orClause);
    }
    if (q.calendarUserId) {
      filters.push(eq(calendarEvents.calendarUserId, q.calendarUserId));
    }
    if (q.personId) {
      filters.push(
        sql`${calendarEvents.matchedPersonIds} @> ARRAY[${q.personId}]::text[]`,
      );
    }
    if (q.organizationId) {
      filters.push(
        sql`${calendarEvents.matchedOrganizationIds} @> ARRAY[${q.organizationId}]::text[]`,
      );
    }
    if (q.householdId) {
      filters.push(
        sql`${calendarEvents.matchedHouseholdIds} @> ARRAY[${q.householdId}]::text[]`,
      );
    }
    if (q.startAfter) {
      filters.push(gte(calendarEvents.startAt, new Date(q.startAfter)));
    }
    if (q.startBefore) {
      filters.push(lt(calendarEvents.startAt, new Date(q.startBefore)));
    }
    const orderBy =
      q.order === "asc"
        ? asc(calendarEvents.startAt)
        : desc(calendarEvents.startAt);
    const where = and(...filters);
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(calendarEvents)
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(calendarEvents).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/calendar-events/:id",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const row = await db
      .select()
      .from(calendarEvents)
      .where(
        and(eq(calendarEvents.id, paramId(req)), visibleToCaller(user.id)),
      )
      .then((r) => r[0]);
    if (!row) return notFound(res, "calendar event");
    res.json(row);
  }),
);

router.patch(
  "/calendar-events/:id/privacy",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = parseOrBadRequest(UpdateCalendarEventPrivacyBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(calendarEvents)
      .set({
        isPrivate: body.isPrivate,
        privateSetByUserId: user.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(calendarEvents.id, paramId(req)),
          eq(calendarEvents.calendarUserId, user.id),
        ),
      )
      .returning();
    if (!row) return notFound(res, "calendar event");
    res.json(row);
  }),
);

export default router;
