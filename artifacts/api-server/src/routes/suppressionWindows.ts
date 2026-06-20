import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { personSuppressionWindows } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, paramId, parseOrBadRequest } from "../lib/helpers";
import { newId } from "../lib/helpers";
import {
  CreatePersonSuppressionWindowBody,
  UpdatePersonSuppressionWindowBody,
  ListPersonSuppressionWindowsQueryParams,
} from "@workspace/api-zod";
import {
  personHasInternalEmail,
  invalidateStaffDefaultSuppressionCache,
} from "../lib/emailMatcher";

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

function formatWindow(r: typeof personSuppressionWindows.$inferSelect) {
  return {
    id: r.id,
    personId: r.personId,
    startDate: r.startDate ? (r.startDate instanceof Date ? r.startDate.toISOString().slice(0, 10) : r.startDate) : null,
    endDate: r.endDate ? (r.endDate instanceof Date ? r.endDate.toISOString().slice(0, 10) : r.endDate) : null,
    notes: r.notes ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

router.get(
  "/person-suppression-windows",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPersonSuppressionWindowsQueryParams, req.query, res);
    if (!q) return;
    const me = getAppUser(req);
    // Listing ALL windows (no personId filter) is admin-only — the notes field
    // can contain sensitive employment context.  Any authenticated user may
    // list windows for a specific person (used on the individual detail page).
    if (!q.personId && (!me || me.role !== "admin")) {
      res.status(403).json({ error: "admin_required" });
      return;
    }
    const rows = q.personId
      ? await db
          .select()
          .from(personSuppressionWindows)
          .where(eq(personSuppressionWindows.personId, q.personId))
      : await db.select().from(personSuppressionWindows);
    // staffDefaultSuppressed is meaningful only for a single-person listing:
    // true when the person is permanently suppressed by default (owns a staff
    // email AND has no explicit window). Adding any window overrides it.
    const staffDefaultSuppressed =
      !!q.personId &&
      rows.length === 0 &&
      (await personHasInternalEmail(q.personId));
    res.json({ data: rows.map(formatWindow), staffDefaultSuppressed });
  }),
);

router.post(
  "/person-suppression-windows",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(CreatePersonSuppressionWindowBody, req.body, res);
    if (!body) return;
    const inserted = await db
      .insert(personSuppressionWindows)
      .values({
        id: newId(),
        personId: body.personId,
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate ? new Date(body.endDate) : null,
        notes: body.notes ?? null,
      })
      .returning();
    // A new window flips this person OUT of the staff-default permanent set.
    invalidateStaffDefaultSuppressionCache();
    res.status(201).json(formatWindow(inserted[0]!));
  }),
);

router.patch(
  "/person-suppression-windows/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const body = parseOrBadRequest(UpdatePersonSuppressionWindowBody, req.body, res);
    if (!body) return;
    const existing = await db
      .select()
      .from(personSuppressionWindows)
      .where(eq(personSuppressionWindows.id, id))
      .then((r) => r[0]);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patch: Partial<typeof personSuppressionWindows.$inferInsert> = {
      updatedAt: new Date(),
    };
    if ("startDate" in body) {
      patch.startDate = body.startDate ? new Date(body.startDate) : null;
    }
    if ("endDate" in body) {
      patch.endDate = body.endDate ? new Date(body.endDate) : null;
    }
    if ("notes" in body) {
      patch.notes = body.notes ?? null;
    }
    const updated = await db
      .update(personSuppressionWindows)
      .set(patch)
      .where(eq(personSuppressionWindows.id, id))
      .returning();
    invalidateStaffDefaultSuppressionCache();
    res.json(formatWindow(updated[0]!));
  }),
);

router.delete(
  "/person-suppression-windows/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const existing = await db
      .select({ id: personSuppressionWindows.id })
      .from(personSuppressionWindows)
      .where(eq(personSuppressionWindows.id, id))
      .then((r) => r[0]);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await db
      .delete(personSuppressionWindows)
      .where(eq(personSuppressionWindows.id, id));
    // Removing the last window may flip this person BACK into the staff-default
    // permanent set, so bust the cache.
    invalidateStaffDefaultSuppressionCache();
    res.status(204).end();
  }),
);

export default router;
