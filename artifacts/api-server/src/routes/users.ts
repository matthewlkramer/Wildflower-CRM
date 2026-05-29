import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { and, asc, eq, isNotNull, isNull, like, not, or } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, paramId, parseOrBadRequest } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { UpdateCurrentUserBody } from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

// Active users by default. Pass ?includeArchived=true to see archived users
// too (e.g. for an admin archive-management screen). User pickers anywhere
// in the app should use the default so archived team members don't show up
// as assignable owners.
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    // Safety net for owner pickers: exclude accounts with no usable identity —
    // a leftover `<clerkId>@unknown.com` placeholder with no name. These are
    // never assignable owners. A row counts as usable if it has any name OR a
    // real (non-placeholder) email. Applied only to the default (picker) path;
    // the admin archive screen (?includeArchived=true) still sees everything.
    const hasUsableIdentity = or(
      not(like(users.email, "%@unknown.com")),
      isNotNull(users.firstName),
      isNotNull(users.lastName),
      isNotNull(users.displayName),
    );
    const rows = await db
      .select()
      .from(users)
      .where(
        includeArchived
          ? undefined
          : and(isNull(users.archivedAt), hasUsableIdentity),
      )
      .orderBy(asc(users.email));
    res.json(rows);
  }),
);

router.get(
  "/users/me",
  asyncHandler(async (req, res) => {
    res.json(getAppUser(req));
  }),
);

router.patch(
  "/users/me",
  asyncHandler(async (req, res) => {
    const me = getAppUser(req);
    if (!me) return notFound(res, "user");
    const body = parseOrBadRequest(UpdateCurrentUserBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, me.id))
      .returning();
    if (!row) return notFound(res, "user");
    res.json(row);
  }),
);

// Admin-only archive/unarchive. Hard delete is intentionally not exposed —
// every owner_user_id FK in the schema is ON DELETE RESTRICT, so a hard
// delete would either fail or require manually re-owning every record the
// archived user touched. Archive preserves history while immediately
// revoking the user's access (see requireAuth).
function requireAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

router.post(
  "/users/:id/archive",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const me = getAppUser(req)!;
    const targetId = paramId(req);
    if (me.id === targetId) {
      res.status(400).json({ error: "cannot_archive_self" });
      return;
    }
    const [row] = await db
      .update(users)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, targetId))
      .returning();
    if (!row) return notFound(res, "user");
    res.json(row);
  }),
);

router.post(
  "/users/:id/unarchive",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const [row] = await db
      .update(users)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(users.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "user");
    res.json(row);
  }),
);

export default router;
