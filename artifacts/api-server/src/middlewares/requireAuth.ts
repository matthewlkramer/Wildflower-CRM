import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { setAppUser } from "../lib/appRequest";

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let user = await db
      .select()
      .from(users)
      .where(eq(users.clerkId, auth.userId))
      .then((rows) => rows[0]);

    if (!user) {
      const email = auth.sessionClaims?.email as string | undefined;

      // First-login adoption: if a pre-seeded user row exists with the same
      // email (typical for placeholder rows backfilled from legacy `owner`
      // text columns), claim it by updating its clerkId rather than
      // inserting a duplicate.
      //
      // BUT: do not silently resurrect an archived user. If an admin
      // archived someone, signing back in should be denied (403) so the
      // operator has to explicitly unarchive — otherwise archive is
      // meaningless as access control.
      if (email) {
        const existing = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .then((rows) => rows[0]);
        if (existing) {
          if (existing.archivedAt) {
            res.status(403).json({ error: "user_archived" });
            return;
          }
          user = await db
            .update(users)
            .set({ clerkId: auth.userId, updatedAt: new Date() })
            .where(eq(users.id, existing.id))
            .returning()
            .then((rows) => rows[0]);
        }
      }

      if (!user) {
        // First-login provisioning. The frontend (dashboard, layout
        // shell, etc.) fires multiple parallel API requests on first
        // page load, so several requireAuth invocations race here for
        // the same Clerk userId — all of them found no user, all of
        // them would try to insert, and only the first would win on
        // the `users_clerk_id_unique` constraint. The losers used to
        // 500 and the dashboard showed broken tiles for the new user's
        // entire first session.
        //
        // Make the insert idempotent on conflict: ON CONFLICT (clerk_id)
        // DO UPDATE updated_at — the bump is a no-op semantically but
        // forces RETURNING to give us the existing row instead of an
        // empty result. All concurrent first-login requests therefore
        // resolve to the same user row.
        user = await db
          .insert(users)
          .values({
            id: nanoid(),
            clerkId: auth.userId,
            email: email ?? `${auth.userId}@unknown.com`,
            role: "team_member",
          })
          .onConflictDoUpdate({
            target: users.clerkId,
            set: { updatedAt: new Date() },
          })
          .returning()
          .then((rows) => rows[0]);
        // Defense-in-depth: if a different request already provisioned
        // an archived row under this clerkId (operator pre-archived a
        // placeholder), the archive check below will still 403 them.
      }
    }

    if (!user) {
      res.status(500).json({ error: "user_provision_failed" });
      return;
    }
    // Deny archived users at the auth boundary. The Google SSO restriction
    // to @wildflowerschools.org is the primary access gate, but archive is
    // defense-in-depth: an admin can immediately revoke a team member's
    // access without waiting on Google Workspace propagation, and it also
    // blocks any pre-seeded placeholder rows that were archived before
    // ever being claimed.
    if (user.archivedAt) {
      res.status(403).json({ error: "user_archived" });
      return;
    }
    setAppUser(req, user);
    next();
  } catch (err) {
    next(err);
  }
};
