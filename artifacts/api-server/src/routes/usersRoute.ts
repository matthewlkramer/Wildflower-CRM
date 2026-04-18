import { Router } from "express";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAuth } from "@clerk/express";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const rows = await db.select().from(users);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const user = (req as any).appUser;
    res.json(user);
  } catch (err) {
    next(err);
  }
});

router.patch("/me", async (req, res, next) => {
  try {
    const user = (req as any).appUser;
    const { firstName, lastName, displayName, defaultFund } = req.body;
    const [updated] = await db
      .update(users)
      .set({
        ...(firstName !== undefined ? { firstName } : {}),
        ...(lastName !== undefined ? { lastName } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(defaultFund !== undefined ? { defaultFund } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
