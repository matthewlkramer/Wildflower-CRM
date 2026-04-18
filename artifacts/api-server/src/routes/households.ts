import { Router } from "express";
import { db } from "@workspace/db";
import { households, householdMembers, individuals, gifts } from "@workspace/db/schema";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";
import { fetchGiftsWith } from "../lib/giftQueries";

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
    const givingHistory = await fetchGiftsWith(eq(gifts.householdId, row.id));
    res.json({ ...row, givingHistory });
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
    const rows = await db
      .select({
        member: householdMembers,
        individual: individuals,
      })
      .from(householdMembers)
      .innerJoin(individuals, eq(householdMembers.individualId, individuals.id))
      .where(and(eq(householdMembers.householdId, req.params.id), eq(householdMembers.isCurrent, true)));
    res.json(rows.map((r) => ({ ...r.individual, membershipRole: r.member.role, membershipStartDate: r.member.startDate })));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/members", async (req, res, next) => {
  try {
    const { individualId, role, startDate } = req.body;
    if (!individualId) { res.status(400).json({ error: "individualId required" }); return; }
    const [created] = await db
      .insert(householdMembers)
      .values({
        id: newId(),
        householdId: req.params.id,
        individualId,
        role: (role as any) ?? "other",
        startDate: startDate ?? null,
        isCurrent: true,
      })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/members/:individualId", async (req, res, next) => {
  try {
    await db
      .delete(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, req.params.id),
          eq(householdMembers.individualId, req.params.individualId),
        ),
      );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
