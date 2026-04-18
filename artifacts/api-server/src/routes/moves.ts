import { Router } from "express";
import { db } from "@workspace/db";
import {
  moves,
  moveParticipants,
  individuals,
  households,
  fundingEntities,
  opportunities,
} from "@workspace/db/schema";
import { eq, and, gte, lte, desc, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const {
      moveType,
      moveLevel,
      donorId,
      opportunityId,
      from,
      to,
      limit: limitStr = "50",
      page: pageStr = "1",
    } = req.query as Record<string, string>;

    const limit = Number(limitStr);
    const page = Number(pageStr);
    const offset = (page - 1) * limit;

    const conditions: any[] = [];
    if (moveType) conditions.push(eq(moves.moveType, moveType as any));
    if (moveLevel) conditions.push(eq(moves.moveLevel, moveLevel as any));
    if (opportunityId) conditions.push(eq(moves.opportunityId, opportunityId));
    if (from) conditions.push(gte(moves.date, new Date(from)));
    if (to) conditions.push(lte(moves.date, new Date(to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalResult, rows] = await Promise.all([
      db.select({ count: count() }).from(moves).where(where),
      db
        .select({
          move: moves,
          individualFirstName: individuals.firstName,
          individualLastName: individuals.lastName,
          householdName: households.name,
          entityName: fundingEntities.legalName,
        })
        .from(moves)
        .leftJoin(individuals, eq(moves.individualId, individuals.id))
        .leftJoin(households, eq(moves.householdId, households.id))
        .leftJoin(fundingEntities, eq(moves.fundingEntityId, fundingEntities.id))
        .where(where)
        .orderBy(desc(moves.date))
        .limit(limit)
        .offset(offset),
    ]);

    res.json({
      data: rows.map((r) => ({
        ...r.move,
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
    const { participantUserIds, ...moveData } = req.body;
    const moveId = newId();
    const [created] = await db
      .insert(moves)
      .values({ id: moveId, ...moveData })
      .returning();

    if (participantUserIds && Array.isArray(participantUserIds) && participantUserIds.length > 0) {
      await db.insert(moveParticipants).values(
        participantUserIds.map((userId: string) => ({
          id: newId(),
          moveId,
          userId,
        })),
      );
    }

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db
      .select()
      .from(moves)
      .where(eq(moves.id, req.params.id));
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    const participants = await db
      .select()
      .from(moveParticipants)
      .where(eq(moveParticipants.moveId, req.params.id));

    res.json({ ...row, participants });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(moves)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(moves.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await db.delete(moves).where(eq(moves.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
