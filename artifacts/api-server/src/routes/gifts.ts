import { Router } from "express";
import { db } from "@workspace/db";
import {
  gifts,
  giftAllocations,
  giftSoftCredits,
  individuals,
} from "@workspace/db/schema";
import { eq, and, gte, lte, desc, count, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId, parseOptionalFiscalYear } from "../lib/helpers";
import {
  selectGiftsWithJoins,
  resolveGiftNames,
  type GiftJoinRow,
} from "../lib/giftQueries";

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
      selectGiftsWithJoins(where)
        .orderBy(desc(gifts.cashReceivedDate))
        .limit(limit)
        .offset(offset) as Promise<GiftJoinRow[]>,
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
        ...resolveGiftNames(r),
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

function validatePayer(body: any): string | null {
  if (
    body.payerFundingEntityId &&
    body.fundingEntityId &&
    body.payerFundingEntityId === body.fundingEntityId
  ) {
    return "payerFundingEntityId must differ from donor funding entity (leave null if donor is payer)";
  }
  if (body.payerFundingEntityId && body.payerOrganizationId) {
    return "Only one of payerFundingEntityId or payerOrganizationId may be set";
  }
  return null;
}

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

    const payerErr = validatePayer(giftBody);
    if (payerErr) {
      res.status(400).json({ error: payerErr });
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
          fiscalYear: parseOptionalFiscalYear(a.fiscalYear),
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
    const joinedRows = (await selectGiftsWithJoins(
      eq(gifts.id, req.params.id),
    )) as GiftJoinRow[];
    const joined = joinedRows[0];
    if (!joined) { res.status(404).json({ error: "Not found" }); return; }
    const row = joined.gift;
    const names = resolveGiftNames(joined);
    const [allocs, softCredits] = await Promise.all([
      db
        .select()
        .from(giftAllocations)
        .where(eq(giftAllocations.giftId, row.id)),
      db
        .select({
          id: giftSoftCredits.id,
          giftId: giftSoftCredits.giftId,
          individualId: giftSoftCredits.individualId,
          creditType: giftSoftCredits.creditType,
          percentage: giftSoftCredits.percentage,
          notes: giftSoftCredits.notes,
          createdAt: giftSoftCredits.createdAt,
          individualFirstName: individuals.firstName,
          individualLastName: individuals.lastName,
        })
        .from(giftSoftCredits)
        .leftJoin(individuals, eq(giftSoftCredits.individualId, individuals.id))
        .where(eq(giftSoftCredits.giftId, row.id)),
    ]);
    res.json({ ...row, ...names, allocations: allocs, softCredits });
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

    const [existing] = await db
      .select()
      .from(gifts)
      .where(eq(gifts.id, req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const merged = { ...existing, ...giftBody };
    const payerErr = validatePayer(merged);
    if (payerErr) {
      res.status(400).json({ error: payerErr });
      return;
    }

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
            fiscalYear: parseOptionalFiscalYear(a.fiscalYear),
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

// ─── Soft credits ──────────────────────────────────────────────────────────
router.get("/:id/soft-credits", async (req, res, next) => {
  try {
    const rows = await db
      .select({
        id: giftSoftCredits.id,
        giftId: giftSoftCredits.giftId,
        individualId: giftSoftCredits.individualId,
        creditType: giftSoftCredits.creditType,
        percentage: giftSoftCredits.percentage,
        notes: giftSoftCredits.notes,
        createdAt: giftSoftCredits.createdAt,
        individualFirstName: individuals.firstName,
        individualLastName: individuals.lastName,
      })
      .from(giftSoftCredits)
      .leftJoin(individuals, eq(giftSoftCredits.individualId, individuals.id))
      .where(eq(giftSoftCredits.giftId, req.params.id));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const SOFT_CREDIT_TYPES = new Set([
  "spouse",
  "advisor",
  "introducer",
  "event_captain",
  "household_member",
  "other",
]);

function validateSoftCreditBody(body: any, requireAll: boolean): string | null {
  if (requireAll || body.creditType !== undefined) {
    if (!body.creditType || !SOFT_CREDIT_TYPES.has(body.creditType)) {
      return `creditType must be one of ${[...SOFT_CREDIT_TYPES].join(", ")}`;
    }
  }
  if (body.percentage !== undefined && body.percentage !== null) {
    const p = Number(body.percentage);
    if (Number.isNaN(p) || p < 0 || p > 100) {
      return "percentage must be a number between 0 and 100";
    }
  }
  if (requireAll && !body.individualId) {
    return "individualId is required";
  }
  return null;
}

router.post("/:id/soft-credits", async (req, res, next) => {
  try {
    const err = validateSoftCreditBody(req.body, true);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    const [parent] = await db
      .select({ id: gifts.id })
      .from(gifts)
      .where(eq(gifts.id, req.params.id));
    if (!parent) {
      res.status(404).json({ error: "Gift not found" });
      return;
    }
    const { individualId, creditType, percentage, notes } = req.body as any;
    const [created] = await db
      .insert(giftSoftCredits)
      .values({
        id: newId(),
        giftId: req.params.id,
        individualId,
        creditType,
        percentage,
        notes,
      })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/soft-credits/:softCreditId", async (req, res, next) => {
  try {
    const validationErr = validateSoftCreditBody(req.body, false);
    if (validationErr) {
      res.status(400).json({ error: validationErr });
      return;
    }
    const { creditType, percentage, notes } = req.body as any;
    const patch: Record<string, unknown> = {};
    if (creditType !== undefined) patch.creditType = creditType;
    if (percentage !== undefined) patch.percentage = percentage;
    if (notes !== undefined) patch.notes = notes;

    const [updated] = await db
      .update(giftSoftCredits)
      .set(patch)
      .where(
        and(
          eq(giftSoftCredits.id, req.params.softCreditId),
          eq(giftSoftCredits.giftId, req.params.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/soft-credits/:softCreditId", async (req, res, next) => {
  try {
    const deleted = await db
      .delete(giftSoftCredits)
      .where(
        and(
          eq(giftSoftCredits.id, req.params.softCreditId),
          eq(giftSoftCredits.giftId, req.params.id),
        ),
      )
      .returning({ id: giftSoftCredits.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
