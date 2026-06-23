import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { schools, schoolSyncState, SCHOOL_SYNC_STATE_ID } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, type SQL } from "drizzle-orm";
import { ListSchoolsQueryParams, UpdateSchoolBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { activeOnlyUnlessAdmin, archiveOne, unarchiveOne } from "../lib/archive";
import { getAppUser } from "../lib/appRequest";
import { runSchoolSyncIfDue } from "../lib/schoolSyncScheduler";
import { isAirtableConfigured } from "../lib/airtableClient";
import { logger } from "../lib/logger";

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

// Shape the singleton run-state row into the wire response. `configured`
// reflects whether Airtable credentials are present — the sync is a no-op
// without them, so the panel can warn instead of looking silently broken.
async function readSchoolSyncStatus(): Promise<{
  configured: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  schoolsFetched: number | null;
  schoolsUpserted: number | null;
  staleInDb: number | null;
  updatedAt: string | null;
}> {
  const row = await db
    .select()
    .from(schoolSyncState)
    .where(eq(schoolSyncState.id, SCHOOL_SYNC_STATE_ID))
    .then((r) => r[0]);
  return {
    configured: isAirtableConfigured(),
    lastRunStartedAt: row?.lastRunStartedAt?.toISOString() ?? null,
    lastRunFinishedAt: row?.lastRunFinishedAt?.toISOString() ?? null,
    lastStatus: row?.lastStatus ?? null,
    lastError: row?.lastError ?? null,
    schoolsFetched: row?.schoolsFetched ?? null,
    schoolsUpserted: row?.schoolsUpserted ?? null,
    staleInDb: row?.staleInDb ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

// Admin-only: last Airtable → schools sync run state. Mirrors the per-user
// Google sync health panel — surfaces the singleton run-state row that the
// scheduler writes after every run so admins can see sync health.
router.get(
  "/admin/school-sync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(await readSchoolSyncStatus());
  }),
);

// Admin-only: trigger an immediate sync. Wraps the same locked code path the
// scheduler uses (force-bypasses the "due" check). The run is synchronous —
// the schools pull is cheap (a few Airtable pages) and bounded, so we wait and
// return the updated state. A contended advisory lock (another run in flight)
// just returns the current state rather than starting a second run.
router.post(
  "/admin/school-sync/run",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await runSchoolSyncIfDue({ force: true });
    } catch (err) {
      logger.error({ err }, "Admin-triggered school sync failed");
      res.status(502).json({
        error: "school_sync_failed",
        message: err instanceof Error ? err.message : String(err),
        status: await readSchoolSyncStatus(),
      });
      return;
    }
    res.json(await readSchoolSyncStatus());
  }),
);

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
