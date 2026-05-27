import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { savedViews } from "@workspace/db/schema";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
} from "../lib/helpers";
// Use the orval-generated zod schemas. `state` is opaque jsonb owned
// by the client (filters + sort blob, shape varies per list page) so
// the spec just types it as a string-keyed record of unknowns — we're
// only validating the envelope.
import {
  CreateSavedViewBody as CreateSavedViewBodyZ,
  UpdateSavedViewBody as UpdateSavedViewBodyZ,
  ListSavedViewsQueryParams as ListQueryZ,
} from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

/**
 * List views for a single list page. Returns team views (created by
 * anyone) + the caller's own individual views. Team views come first
 * so they're visually grouped in the bar.
 */
router.get(
  "/saved-views",
  asyncHandler(async (req, res) => {
    const parsed = ListQueryZ.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "listKey is required",
        details: parsed.error.flatten(),
      });
      return;
    }
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const rows = await db
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.listKey, parsed.data.listKey),
          or(
            eq(savedViews.visibility, "team"),
            eq(savedViews.creatorUserId, user.id),
          ),
        ),
      )
      // Team views first, then alphabetical. CASE expression keeps
      // the ordering deterministic across postgres versions.
      .orderBy(
        sql`CASE WHEN ${savedViews.visibility} = 'team' THEN 0 ELSE 1 END`,
        asc(savedViews.name),
      );
    res.json({ data: rows });
  }),
);

router.post(
  "/saved-views",
  asyncHandler(async (req, res) => {
    const parsed = CreateSavedViewBodyZ.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "invalid saved view body",
        details: parsed.error.flatten(),
      });
      return;
    }
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const [row] = await db
      .insert(savedViews)
      .values({
        id: newId(),
        listKey: parsed.data.listKey,
        name: parsed.data.name,
        visibility: parsed.data.visibility,
        state: parsed.data.state,
        creatorUserId: user.id,
      })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/saved-views/:id",
  asyncHandler(async (req, res) => {
    const parsed = UpdateSavedViewBodyZ.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "invalid saved view body",
        details: parsed.error.flatten(),
      });
      return;
    }
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const id = paramId(req);
    const existing = await db
      .select()
      .from(savedViews)
      .where(eq(savedViews.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "saved view");
    if (existing.creatorUserId !== user.id) {
      res.status(403).json({
        error: "forbidden",
        message: "Only the creator can edit this view.",
      });
      return;
    }
    // The generated schema accepts any combination of fields. Defend
    // against an empty PATCH body explicitly — otherwise we'd issue an
    // UPDATE that only touches updatedAt, which is silently confusing.
    const hasAny =
      parsed.data.name !== undefined ||
      parsed.data.visibility !== undefined ||
      parsed.data.state !== undefined;
    if (!hasAny) {
      res.status(400).json({
        error: "validation_error",
        message: "PATCH body must contain at least one of name, visibility, state.",
      });
      return;
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;
    if (parsed.data.state !== undefined) patch.state = parsed.data.state;
    const [row] = await db
      .update(savedViews)
      .set(patch)
      .where(eq(savedViews.id, id))
      .returning();
    if (!row) return notFound(res, "saved view");
    res.json(row);
  }),
);

router.delete(
  "/saved-views/:id",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const id = paramId(req);
    const existing = await db
      .select({ creatorUserId: savedViews.creatorUserId })
      .from(savedViews)
      .where(eq(savedViews.id, id))
      .then((r) => r[0]);
    if (!existing) {
      // Idempotent-ish: already gone is fine.
      res.status(204).end();
      return;
    }
    if (existing.creatorUserId !== user.id) {
      res.status(403).json({
        error: "forbidden",
        message: "Only the creator can delete this view.",
      });
      return;
    }
    await db.delete(savedViews).where(eq(savedViews.id, id));
    res.status(204).end();
  }),
);

export default router;
