import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { users, type User } from "@workspace/db/schema";
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  like,
  not,
  or,
  sql,
} from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import {
  AdminCreateUserBody,
  AdminUpdateUserBody,
  UpdateCurrentUserBody,
} from "@workspace/api-zod";
import { diffChanges, recordAudit } from "../lib/audit";

const router: IRouter = Router();
router.use(requireAuth);

// Credentials belong to their dedicated Settings endpoint, never the directory.
function publicUser({ extensionToken: _token, ...user }: User) {
  return user;
}

router.get(
  "/admin/users",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await db.select().from(users).orderBy(asc(users.email));
    res.json(rows.map(publicUser));
  }),
);

router.post(
  "/admin/users",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(AdminCreateUserBody, req.body, res);
    if (!body) return;
    const email = body.email.trim().toLowerCase();
    if (!email.endsWith("@wildflowerschools.org")) {
      res
        .status(400)
        .json({
          error: "wildflower_email_required",
          message: "Use a @wildflowerschools.org Google sign-in address.",
        });
      return;
    }
    const row = await db.transaction(async (tx) => {
      if (!(await lockAdmin(tx, req, res))) return;
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);
      if (existing.length) {
        res
          .status(409)
          .json({
            error: "user_exists",
            message:
              "This email is already in the directory. Edit or restore the existing user.",
          });
        return;
      }
      const id = newId();
      const [created] = await tx
        .insert(users)
        .values({
          id,
          clerkId: `pending_${id}`,
          email,
          role: body.role,
          ...cleanNames(body),
        })
        .returning();
      await recordAudit(tx, req, {
        action: "create",
        entityType: "user",
        entityId: id,
        summary: `Added CRM user ${email}`,
        changes: diffChanges(undefined, publicUser(created), [
          "email",
          "role",
          "firstName",
          "lastName",
          "displayName",
        ]),
      });
      return created;
    });
    if (row) res.status(201).json(publicUser(row));
  }),
);

router.patch(
  "/admin/users/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(AdminUpdateUserBody, req.body, res);
    if (!body) return;
    await changeUser(
      req,
      res,
      { ...cleanNames(body), ...(body.role ? { role: body.role } : {}) },
      "update",
    );
  }),
);

// Active users by default. Pass ?includeArchived=true to see archived users
// too (e.g. for an admin archive-management screen). User pickers anywhere
// in the app should use the default so archived team members don't show up
// as assignable owners.
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === "true";
    if (includeArchived && !requireAdmin(req, res)) return;
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
    res.json(rows.map(publicUser));
  }),
);

router.get(
  "/users/me",
  asyncHandler(async (req, res) => {
    const me = getAppUser(req);
    if (!me) return notFound(res, "user");
    res.json(publicUser(me));
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
    res.json(publicUser(row));
  }),
);

// Admin-only archive/unarchive. Hard delete is intentionally not exposed —
// every owner_user_id FK in the schema is ON DELETE RESTRICT, so a hard
// delete would either fail or require manually re-owning every record the
// archived user touched. Archive preserves history while immediately
// revoking the user's access (see requireAuth).
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

function cleanNames(body: {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
}) {
  return Object.fromEntries(
    (["firstName", "lastName", "displayName"] as const)
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]?.trim() || null]),
  ) as Pick<Partial<User>, "firstName" | "lastName" | "displayName">;
}

type UserTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Serialize access changes and re-check the actor after locking. Two admins
// cannot concurrently demote one another and leave the CRM without an admin.
async function lockAdmin(tx: UserTx, req: Request, res: Response) {
  await tx.execute(sql`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`);
  const [actor] = await tx
    .select()
    .from(users)
    .where(eq(users.id, getAppUser(req)!.id));
  if (!actor || actor.archivedAt || actor.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

async function changeUser(
  req: Request,
  res: Response,
  patch: Partial<
    Pick<User, "role" | "firstName" | "lastName" | "displayName" | "archivedAt">
  >,
  action: "update" | "archive" | "unarchive",
) {
  const row = await db.transaction(async (tx) => {
    if (!(await lockAdmin(tx, req, res))) return;
    const [before] = await tx
      .select()
      .from(users)
      .where(eq(users.id, paramId(req)));
    if (!before) {
      notFound(res, "user");
      return;
    }
    if (
      before.id === getAppUser(req)!.id &&
      (patch.archivedAt || (patch.role && patch.role !== before.role))
    ) {
      res
        .status(400)
        .json({
          error: "cannot_change_own_access",
          message:
            "Another admin must change your role or deactivate your account.",
        });
      return;
    }
    const changes = diffChanges(
      before,
      { ...before, ...patch },
      Object.keys(patch),
    );
    if (!changes.length) return before;
    const [updated] = await tx
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, before.id))
      .returning();
    await recordAudit(tx, req, {
      action,
      entityType: "user",
      entityId: before.id,
      summary: `${action === "archive" ? "Deactivated" : action === "unarchive" ? "Restored" : "Updated"} CRM user ${before.email}`,
      changes,
    });
    return updated;
  });
  if (row) res.json(publicUser(row));
}

router.post(
  "/users/:id/archive",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await changeUser(req, res, { archivedAt: new Date() }, "archive");
  }),
);

router.post(
  "/users/:id/unarchive",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    await changeUser(req, res, { archivedAt: null }, "unarchive");
  }),
);

export default router;
