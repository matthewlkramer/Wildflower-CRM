import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { calendarMeetingFilters } from "@workspace/db/schema";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, parseOrBadRequest } from "../lib/helpers";
import { UpdateCalendarMeetingFiltersBody } from "@workspace/api-zod";
import { DEFAULT_MEETING_FILTER_CONFIG } from "../lib/calendarMeetingFilter";

const router: IRouter = Router();
router.use(requireAuth);

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

function formatConfig(row: typeof calendarMeetingFilters.$inferSelect) {
  return {
    titlePatterns: row.titlePatterns ?? DEFAULT_MEETING_FILTER_CONFIG.titlePatterns,
    attendeeCountCutoff:
      row.attendeeCountCutoff !== null && row.attendeeCountCutoff !== undefined
        ? row.attendeeCountCutoff
        : DEFAULT_MEETING_FILTER_CONFIG.attendeeCountCutoff,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get(
  "/calendar-meeting-filters",
  asyncHandler(async (req, res) => {
    await db
      .insert(calendarMeetingFilters)
      .values({ id: "singleton" })
      .onConflictDoNothing();
    const row = await db
      .select()
      .from(calendarMeetingFilters)
      .then((r) => r[0]);
    if (!row) {
      res.json({
        ...DEFAULT_MEETING_FILTER_CONFIG,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    res.json(formatConfig(row));
  }),
);

router.put(
  "/calendar-meeting-filters",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(UpdateCalendarMeetingFiltersBody, req.body, res);
    if (!body) return;
    await db
      .insert(calendarMeetingFilters)
      .values({ id: "singleton" })
      .onConflictDoNothing();
    const updated = await db
      .update(calendarMeetingFilters)
      .set({
        titlePatterns: body.titlePatterns,
        attendeeCountCutoff: body.attendeeCountCutoff !== undefined ? body.attendeeCountCutoff : undefined,
        updatedAt: new Date(),
      })
      .returning();
    res.json(formatConfig(updated[0]!));
  }),
);

export default router;
