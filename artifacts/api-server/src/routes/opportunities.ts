import { Router } from "express";
import { db } from "@workspace/db";
import { opportunities, individuals, households, fundingEntities, users } from "@workspace/db/schema";
import { eq, and, desc, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId, parseOptionalFiscalYear } from "../lib/helpers";

const router = Router();

router.use(requireAuth);

router.get("/pipeline", async (req, res, next) => {
  try {
    const { fund, fiscalYear } = req.query as Record<string, string>;

    const conditions: any[] = [];
    if (fund) conditions.push(eq(opportunities.fund, fund as any));
    const parsedFiscalYearPipeline = parseOptionalFiscalYear(fiscalYear);
    if (parsedFiscalYearPipeline)
      conditions.push(eq(opportunities.fiscalYear, parsedFiscalYearPipeline));

    const stages = [
      "pre_conversation", "conversation", "solicitation", "negotiation",
      "committed", "funded", "stewarding",
    ] as const;

    const results: Record<string, any[]> = {};
    for (const stage of stages) {
      results[stage] = await db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.stage, stage), ...(conditions.length > 0 ? conditions : [])))
        .orderBy(desc(opportunities.amountExpected));
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const {
      fund, stage, donorType, subtype, ownerId, fiscalYear,
      limit: limitStr = "100", page: pageStr = "1",
    } = req.query as Record<string, string>;

    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (fund) conditions.push(eq(opportunities.fund, fund as any));
    if (stage) conditions.push(eq(opportunities.stage, stage as any));
    if (donorType) conditions.push(eq(opportunities.donorType, donorType as any));
    if (subtype) conditions.push(eq(opportunities.subtype, subtype as any));
    if (ownerId) conditions.push(eq(opportunities.ownerUserId, ownerId));
    const parsedFiscalYear = parseOptionalFiscalYear(fiscalYear);
    if (parsedFiscalYear)
      conditions.push(eq(opportunities.fiscalYear, parsedFiscalYear));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(opportunities).where(where),
      db
        .select({
          opp: opportunities,
          ownerName: users.displayName,
          individualFirstName: individuals.firstName,
          individualLastName: individuals.lastName,
          householdName: households.name,
          entityName: fundingEntities.legalName,
        })
        .from(opportunities)
        .leftJoin(users, eq(opportunities.ownerUserId, users.id))
        .leftJoin(individuals, eq(opportunities.individualId, individuals.id))
        .leftJoin(households, eq(opportunities.householdId, households.id))
        .leftJoin(fundingEntities, eq(opportunities.fundingEntityId, fundingEntities.id))
        .where(where)
        .orderBy(desc(opportunities.updatedAt))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      data: rows.map((r) => ({
        ...r.opp,
        ownerName: r.ownerName,
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
    const [created] = await db.insert(opportunities).values({ id: newId(), ...req.body }).returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(opportunities)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(opportunities.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db.delete(opportunities).where(eq(opportunities.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
