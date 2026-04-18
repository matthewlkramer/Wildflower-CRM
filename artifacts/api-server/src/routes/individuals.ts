import { Router } from "express";
import { db } from "@workspace/db";
import { individuals, users } from "@workspace/db/schema";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const {
      search,
      stage,
      enthusiasm,
      capacityRating,
      ownerId,
      limit: limitStr = "50",
      page: pageStr = "1",
    } = req.query as Record<string, string>;

    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (search) {
      conditions.push(
        sql`(${individuals.firstName} || ' ' || ${individuals.lastName} ilike ${"%" + search + "%"} OR ${individuals.primaryEmail} ilike ${"%" + search + "%"})`,
      );
    }
    if (stage) conditions.push(eq(individuals.donorCultivationStage, stage as any));
    if (enthusiasm) conditions.push(eq(individuals.enthusiasm, enthusiasm as any));
    if (capacityRating) conditions.push(eq(individuals.capacityRating, capacityRating as any));
    if (ownerId) conditions.push(eq(individuals.relationshipOwnerUserId, ownerId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(individuals).where(where),
      db
        .select({
          individual: individuals,
          ownerDisplayName: users.displayName,
        })
        .from(individuals)
        .leftJoin(users, eq(individuals.relationshipOwnerUserId, users.id))
        .where(where)
        .orderBy(desc(individuals.updatedAt))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      data: rows.map((r) => ({
        ...r.individual,
        ownerDisplayName: r.ownerDisplayName,
      })),
      total: totalResult[0].count,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const [created] = await db
      .insert(individuals)
      .values({ id: newId(), ...req.body })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db
      .select({
        individual: individuals,
        ownerDisplayName: users.displayName,
      })
      .from(individuals)
      .leftJoin(users, eq(individuals.relationshipOwnerUserId, users.id))
      .where(eq(individuals.id, req.params.id));

    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ...row.individual, ownerDisplayName: row.ownerDisplayName });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(individuals)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(individuals.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const [deleted] = await db
      .delete(individuals)
      .where(eq(individuals.id, req.params.id))
      .returning();
    if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
