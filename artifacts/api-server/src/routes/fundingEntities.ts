import { Router } from "express";
import { db } from "@workspace/db";
import {
  fundingEntities,
  fundingEntityPeople,
  individuals,
  users,
} from "@workspace/db/schema";
import { eq, and, sql, desc, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const {
      search,
      subtype,
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
        sql`(${fundingEntities.legalName} ilike ${"%" + search + "%"} OR ${fundingEntities.displayName} ilike ${"%" + search + "%"})`,
      );
    }
    if (subtype) conditions.push(eq(fundingEntities.subtype, subtype as any));
    if (ownerId) conditions.push(eq(fundingEntities.relationshipOwnerUserId, ownerId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(fundingEntities).where(where),
      db
        .select({
          entity: fundingEntities,
          ownerDisplayName: users.displayName,
        })
        .from(fundingEntities)
        .leftJoin(users, eq(fundingEntities.relationshipOwnerUserId, users.id))
        .where(where)
        .orderBy(desc(fundingEntities.updatedAt))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      data: rows.map((r) => ({ ...r.entity, ownerDisplayName: r.ownerDisplayName })),
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
      .insert(fundingEntities)
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
      .select()
      .from(fundingEntities)
      .where(eq(fundingEntities.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(fundingEntities)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(fundingEntities.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db
      .delete(fundingEntities)
      .where(eq(fundingEntities.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/:id/people", async (req, res, next) => {
  try {
    const rows = await db
      .select({
        link: fundingEntityPeople,
        individual: individuals,
      })
      .from(fundingEntityPeople)
      .leftJoin(individuals, eq(fundingEntityPeople.individualId, individuals.id))
      .where(eq(fundingEntityPeople.fundingEntityId, req.params.id));
    res.json(rows.map((r) => ({ ...r.link, individual: r.individual })));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/people", async (req, res, next) => {
  try {
    const { individualId, role } = req.body;
    const [created] = await db
      .insert(fundingEntityPeople)
      .values({
        id: newId(),
        fundingEntityId: req.params.id,
        individualId,
        role,
      })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/people/:individualId", async (req, res, next) => {
  try {
    await db
      .delete(fundingEntityPeople)
      .where(
        and(
          eq(fundingEntityPeople.fundingEntityId, req.params.id),
          eq(fundingEntityPeople.individualId, req.params.individualId),
        ),
      );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
