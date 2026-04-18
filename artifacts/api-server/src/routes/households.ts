import { Router } from "express";
import { db } from "@workspace/db";
import { households, individuals } from "@workspace/db/schema";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const { search, limit: limitStr = "50", page: pageStr = "1" } = req.query as Record<string, string>;
    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const where = search ? sql`${households.name} ilike ${"%" + search + "%"}` : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(households).where(where),
      db.select().from(households).where(where).orderBy(desc(households.updatedAt)).limit(limit).offset(offset),
    ]);

    res.json({ data: rows, total: totalResult[0].count, page, limit });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const [created] = await db.insert(households).values({ id: newId(), ...req.body }).returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db.select().from(households).where(eq(households.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(households)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(households.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db.delete(households).where(eq(households.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/:id/members", async (req, res, next) => {
  try {
    const members = await db.select().from(individuals).where(eq(individuals.householdId, req.params.id));
    res.json(members);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/members", async (req, res, next) => {
  try {
    const { individualId } = req.body;
    if (!individualId) { res.status(400).json({ error: "individualId required" }); return; }
    const [updated] = await db
      .update(individuals)
      .set({ householdId: req.params.id, updatedAt: new Date() })
      .where(eq(individuals.id, individualId))
      .returning();
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/members/:individualId", async (req, res, next) => {
  try {
    await db
      .update(individuals)
      .set({ householdId: null, updatedAt: new Date() })
      .where(and(eq(individuals.id, req.params.individualId), eq(individuals.householdId, req.params.id)));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
