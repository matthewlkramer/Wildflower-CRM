import { Router } from "express";
import { db } from "@workspace/db";
import {
  gifts,
  giftAllocations,
  individuals,
  households,
  fundingEntities,
  pledges,
} from "@workspace/db/schema";
import { eq, and, gte, lte, desc, count, inArray } from "drizzle-orm";
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
      campaignId,
      from,
      to,
      limit: limitStr = "50",
      page: pageStr = "1",
    } = req.query as Record<string, string>;

    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (reconciled !== undefined)
      conditions.push(eq(gifts.reconciled, reconciled === "true"));
    if (pledgeId) conditions.push(eq(gifts.pledgeId, pledgeId));
    if (campaignId) conditions.push(eq(gifts.campaignId, campaignId));
    if (from) conditions.push(gte(gifts.cashReceivedDate, new Date(from)));
    if (to) conditions.push(lte(gifts.cashReceivedDate, new Date(to)));

    if (fund) {
      const matchingGiftIds = await db
        .selectDistinct({ giftId: giftAllocations.giftId })
        .from(giftAllocations)
        .where(eq(giftAllocations.fund, fund as any));
      const ids = matchingGiftIds.map((r) => r.giftId);
      if (ids.length === 0) {
        res.json({ data: [], total: 0, page, limit });
        return;
      }
      conditions.push(inArray(gifts.id, ids));
    }

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

    const giftIds = rows.map((r) => r.gift.id);
    const allocs = giftIds.length
      ? await db
          .select()
          .from(giftAllocations)
          .where(inArray(giftAllocations.giftId, giftIds))
      : [];

    const allocsByGift = allocs.reduce<Record<string, typeof allocs>>(
      (acc, a) => {
        (acc[a.giftId] ??= []).push(a);
        return acc;
      },
      {},
    );

    res.json({
      data: rows.map((r) => ({
        ...r.gift,
        donorName: r.individualFirstName
          ? `${r.individualFirstName} ${r.individualLastName}`
          : r.householdName ?? r.entityName,
        allocations: allocsByGift[r.gift.id] ?? [],
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
    const { allocations, ...giftBody } = req.body as {
      allocations?: Array<{ fund: string; amount: string; fiscalYear?: string; notes?: string }>;
      [k: string]: any;
    };

    if (!Array.isArray(allocations) || allocations.length === 0) {
      res.status(400).json({ error: "At least one allocation is required" });
      return;
    }

    const allocSum = allocations.reduce((s, a) => s + Number(a.amount), 0);
    if (Math.abs(allocSum - Number(giftBody.amount)) > 0.001) {
      res.status(400).json({
        error: `Allocation sum (${allocSum}) must equal gift amount (${giftBody.amount})`,
      });
      return;
    }

    const giftId = newId();
    const [created] = await db
      .insert(gifts)
      .values({ id: giftId, ...(giftBody as any) })
      .returning();

    const createdAllocs = await db
      .insert(giftAllocations)
      .values(
        allocations.map((a) => ({
          id: newId(),
          giftId,
          fund: a.fund as any,
          amount: a.amount,
          fiscalYear: a.fiscalYear,
          notes: a.notes,
        })),
      )
      .returning();

    res.status(201).json({ ...created, allocations: createdAllocs });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db.select().from(gifts).where(eq(gifts.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const allocs = await db
      .select()
      .from(giftAllocations)
      .where(eq(giftAllocations.giftId, row.id));
    res.json({ ...row, allocations: allocs });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { allocations, ...giftBody } = req.body as {
      allocations?: Array<{ fund: string; amount: string; fiscalYear?: string; notes?: string }>;
      [k: string]: any;
    };

    const [updated] = await db
      .update(gifts)
      .set({ ...giftBody, updatedAt: new Date() })
      .where(eq(gifts.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }

    if (Array.isArray(allocations)) {
      const allocSum = allocations.reduce((s, a) => s + Number(a.amount), 0);
      if (Math.abs(allocSum - Number(updated.amount)) > 0.001) {
        res.status(400).json({
          error: `Allocation sum (${allocSum}) must equal gift amount (${updated.amount})`,
        });
        return;
      }
      await db.delete(giftAllocations).where(eq(giftAllocations.giftId, updated.id));
      if (allocations.length > 0) {
        await db.insert(giftAllocations).values(
          allocations.map((a) => ({
            id: newId(),
            giftId: updated.id,
            fund: a.fund as any,
            amount: a.amount,
            fiscalYear: a.fiscalYear,
            notes: a.notes,
          })),
        );
      }
    }

    const finalAllocs = await db
      .select()
      .from(giftAllocations)
      .where(eq(giftAllocations.giftId, updated.id));
    res.json({ ...updated, allocations: finalAllocs });
  } catch (err) {
    next(err);
  }
});

export default router;
