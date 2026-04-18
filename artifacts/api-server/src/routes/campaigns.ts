import { Router } from "express";
import { db } from "@workspace/db";
import { campaigns } from "@workspace/db/schema";
import { eq, and, sql, desc, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const {
      search,
      fund,
      isActive,
      fiscalYear,
      limit: limitStr = "50",
      page: pageStr = "1",
    } = req.query as Record<string, string>;
    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (search) conditions.push(sql`${campaigns.name} ilike ${"%" + search + "%"}`);
    if (fund) conditions.push(eq(campaigns.fund, fund as any));
    if (isActive !== undefined)
      conditions.push(eq(campaigns.isActive, isActive === "true"));
    if (fiscalYear) conditions.push(eq(campaigns.fiscalYear, fiscalYear as any));
    const where = conditions.length ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(campaigns).where(where),
      db
        .select()
        .from(campaigns)
        .where(where)
        .orderBy(desc(campaigns.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({ data: rows, total: totalResult[0].count, page, limit });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const [created] = await db
      .insert(campaigns)
      .values({ id: newId(), ...req.body })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(campaigns)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(campaigns.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db.delete(campaigns).where(eq(campaigns.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
