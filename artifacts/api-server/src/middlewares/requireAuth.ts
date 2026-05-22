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
      if (email) {
        const existing = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .then((rows) => rows[0]);
        if (existing) {
          user = await db
            .update(users)
            .set({ clerkId: auth.userId, updatedAt: new Date() })
            .where(eq(users.id, existing.id))
            .returning()
            .then((rows) => rows[0]);
        }
      }

      if (!user) {
        user = await db
          .insert(users)
          .values({
            id: nanoid(),
            clerkId: auth.userId,
            email: email ?? `${auth.userId}@unknown.com`,
            role: "team_member",
          })
          .returning()
          .then((rows) => rows[0]);
      }
    }

    if (!user) {
      res.status(500).json({ error: "user_provision_failed" });
      return;
    }
    setAppUser(req, user);
    next();
  } catch (err) {
    next(err);
  }
};
