import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { wildflowerUpdates } from "@workspace/db/schema";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, parseOrBadRequest } from "../lib/helpers";
import { UpdateWildflowerUpdateBody } from "@workspace/api-zod";
import { invalidateWildflowerUpdateNoteCache } from "../lib/wildflowerUpdatesNote";

/**
 * The single shared, admin-editable "Wildflower updates" note.
 *
 * GET is readable by any authenticated user (it shows in the activity /
 * proposal context); PUT is admin-only. The note is fed into the AI
 * prompts for donor next-step tasks + email-intelligence proposals.
 */
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

function formatConfig(row: typeof wildflowerUpdates.$inferSelect) {
  return {
    content: row.content,
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  };
}

router.get(
  "/wildflower-updates",
  asyncHandler(async (req, res) => {
    // Seed an empty singleton on first read so the row always exists.
    await db
      .insert(wildflowerUpdates)
      .values({ id: "singleton", content: "" })
      .onConflictDoNothing();
    const row = await db
      .select()
      .from(wildflowerUpdates)
      .then((r) => r[0]);
    if (!row) {
      res.json({
        content: "",
        updatedAt: new Date().toISOString(),
        updatedByUserId: null,
      });
      return;
    }
    res.json(formatConfig(row));
  }),
);

router.put(
  "/wildflower-updates",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const me = getAppUser(req);
    const body = parseOrBadRequest(UpdateWildflowerUpdateBody, req.body, res);
    if (!body) return;
    const content = body.content;

    await db
      .insert(wildflowerUpdates)
      .values({ id: "singleton", content, updatedByUserId: me?.id ?? null })
      .onConflictDoUpdate({
        target: wildflowerUpdates.id,
        set: { content, updatedByUserId: me?.id ?? null, updatedAt: new Date() },
      });
    const row = await db
      .select()
      .from(wildflowerUpdates)
      .then((r) => r[0]);
    // Bust the AI-context cache so the next proposal/task suggestion picks
    // up the change immediately.
    invalidateWildflowerUpdateNoteCache();
    res.json(formatConfig(row!));
  }),
);

export default router;
