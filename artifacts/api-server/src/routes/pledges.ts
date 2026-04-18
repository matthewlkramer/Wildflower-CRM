import { Router } from "express";
import { db } from "@workspace/db";
import {
  pledges,
  pledgeInstallments,
  individuals,
  households,
  fundingEntities,
} from "@workspace/db/schema";
import { eq, and, lte, gte, desc, sql, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const {
      fund,
      status,
      donorId,
      limit: limitStr = "50",
      page: pageStr = "1",
    } = req.query as Record<string, string>;

    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (fund) conditions.push(eq(pledges.fund, fund as any));
    if (status) conditions.push(eq(pledges.status, status as any));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(pledges).where(where),
      db
        .select({
          pledge: pledges,
          individualFirstName: individuals.firstName,
          individualLastName: individuals.lastName,
          householdName: households.name,
          entityName: fundingEntities.legalName,
        })
        .from(pledges)
        .leftJoin(individuals, eq(pledges.individualId, individuals.id))
        .leftJoin(households, eq(pledges.householdId, households.id))
        .leftJoin(fundingEntities, eq(pledges.fundingEntityId, fundingEntities.id))
        .where(where)
        .orderBy(desc(pledges.updatedAt))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      data: rows.map((r) => ({
        ...r.pledge,
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
    const {
      installments: installmentData,
      ...pledgeData
    } = req.body;

    const pledgeId = newId();
    const [created] = await db
      .insert(pledges)
      .values({ id: pledgeId, ...pledgeData })
      .returning();

    if (installmentData && Array.isArray(installmentData) && installmentData.length > 0) {
      await db.insert(pledgeInstallments).values(
        installmentData.map((inst: any, idx: number) => ({
          id: newId(),
          pledgeId,
          installmentNumber: idx + 1,
          dueDate: new Date(inst.dueDate),
          amount: String(inst.amount),
          status: "scheduled" as const,
        })),
      );
    } else {
      await db.insert(pledgeInstallments).values({
        id: newId(),
        pledgeId,
        installmentNumber: 1,
        dueDate: new Date(pledgeData.pledgeDate),
        amount: String(pledgeData.totalCommittedAmount),
        status: "scheduled" as const,
      });
    }

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get("/schedule", async (req, res, next) => {
  try {
    const { from, to, fund } = req.query as Record<string, string>;
    const conditions: any[] = [];
    if (from) conditions.push(gte(pledgeInstallments.dueDate, new Date(from)));
    if (to) conditions.push(lte(pledgeInstallments.dueDate, new Date(to)));
    if (fund) conditions.push(eq(pledges.fund, fund as any));

    const rows = await db
      .select({
        installment: pledgeInstallments,
        pledge: pledges,
      })
      .from(pledgeInstallments)
      .leftJoin(pledges, eq(pledgeInstallments.pledgeId, pledges.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(pledgeInstallments.dueDate);

    res.json(rows.map((r) => ({ ...r.installment, pledge: r.pledge })));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db
      .select()
      .from(pledges)
      .where(eq(pledges.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    const installmentRows = await db
      .select()
      .from(pledgeInstallments)
      .where(eq(pledgeInstallments.pledgeId, req.params.id))
      .orderBy(pledgeInstallments.installmentNumber);

    res.json({ ...row, installments: installmentRows });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(pledges)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(pledges.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/installments/:installmentId", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(pledgeInstallments)
      .set({ ...req.body, updatedAt: new Date() })
      .where(
        and(
          eq(pledgeInstallments.id, req.params.installmentId),
          eq(pledgeInstallments.pledgeId, req.params.id),
        ),
      )
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }

    const amountPaid = await db
      .select({ total: sql<string>`coalesce(sum(amount), 0)` })
      .from(pledgeInstallments)
      .where(
        and(
          eq(pledgeInstallments.pledgeId, req.params.id),
          eq(pledgeInstallments.status, "paid"),
        ),
      )
      .then((r) => r[0]?.total ?? "0");

    await db
      .update(pledges)
      .set({ amountReceived: amountPaid, updatedAt: new Date() })
      .where(eq(pledges.id, req.params.id));

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
