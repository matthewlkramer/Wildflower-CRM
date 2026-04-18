import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

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

    (req as any).appUser = user;
    next();
  } catch (err) {
    next(err);
  }
};
