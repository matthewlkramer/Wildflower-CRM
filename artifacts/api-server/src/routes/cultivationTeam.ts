import { Router } from "express";
import { db } from "@workspace/db";
import { cultivationTeamMembers } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const { ownerType, ownerId } = req.query as Record<string, string>;
    if (!ownerType || !ownerId) {
      res.status(400).json({ error: "ownerType and ownerId are required" });
      return;
    }
    const rows = await db
      .select()
      .from(cultivationTeamMembers)
      .where(
        and(
          eq(cultivationTeamMembers.ownerType, ownerType as any),
          eq(cultivationTeamMembers.ownerId, ownerId),
        ),
      );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const [created] = await db
      .insert(cultivationTeamMembers)
      .values({ id: newId(), ...req.body })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(cultivationTeamMembers)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(cultivationTeamMembers.id, req.params.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db
      .delete(cultivationTeamMembers)
      .where(eq(cultivationTeamMembers.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
