import { Router } from "express";
import { db } from "@workspace/db";
import {
  gifts,
  individuals,
  households,
  fundingEntities,
  pledges,
} from "@workspace/db/schema";
import { eq, and, gte, lte, desc, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const {
      fund,
      reconciled,
      pledgeId,
      from,
      to,
      limit: limitStr = "50",
      page: pageStr = "1",
    } = req.query as Record<string, string>;

    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (fund) conditions.push(eq(gifts.fund, fund as any));
    if (reconciled !== undefined)
      conditions.push(eq(gifts.reconciled, reconciled === "true"));
    if (pledgeId) conditions.push(eq(gifts.pledgeId, pledgeId));
    if (from) conditions.push(gte(gifts.cashReceivedDate, new Date(from)));
    if (to) conditions.push(lte(gifts.cashReceivedDate, new Date(to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(gifts).where(where),
      db
        .select({
          gift: gifts,
          individualFirstName: individuals.firstName,
          individualLastName: individuals.lastName,
          householdName: households.name,
          entityName: fundingEntities.legalName,
        })
        .from(gifts)
        .leftJoin(individuals, eq(gifts.individualId, individuals.id))
        .leftJoin(households, eq(gifts.householdId, households.id))
        .leftJoin(fundingEntities, eq(gifts.fundingEntityId, fundingEntities.id))
        .where(where)
        .orderBy(desc(gifts.cashReceivedDate))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      data: rows.map((r) => ({
        ...r.gift,
        donorName: r.individualFirstName
          ? `${r.individualFirstName} ${r.individualLastName}`
          : r.householdName ?? r.entityName,
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
      .insert(gifts)
      .values({ id: newId(), ...req.body })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db.select().from(gifts).where(eq(gifts.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(gifts)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(gifts.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
