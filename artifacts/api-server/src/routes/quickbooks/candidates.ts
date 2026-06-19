import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { stagedPayments, giftsAndPayments } from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { asyncHandler, notFound, paramId } from "../../lib/helpers";
import { donorOf } from "../../lib/quickbooksLink";
import { giftCandidateJoins, giftCandidateSelect } from "./shared";

const router: IRouter = Router();

// ─── GET /staged-payments/:id/gift-candidates ──────────────────────────────
// Existing gifts for the staged row's saved donor whose amount is at or just
// above the staged amount (a Donorbox-style processor fee makes the CRM gross
// gift slightly larger than the QB net deposit). Empty when no donor/amount.
router.get(
  "/staged-payments/:id/gift-candidates",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const staged = await db
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!staged) return notFound(res, "staged payment");

    const donor = donorOf(staged);
    const donorFilter =
      donor.organizationId != null
        ? eq(giftsAndPayments.organizationId, donor.organizationId)
        : donor.individualGiverPersonId != null
          ? eq(
              giftsAndPayments.individualGiverPersonId,
              donor.individualGiverPersonId,
            )
          : donor.householdId != null
            ? eq(giftsAndPayments.householdId, donor.householdId)
            : null;

    if (donorFilter == null || staged.amount == null) {
      res.json({ data: [] });
      return;
    }

    const rows = await giftCandidateJoins(
      db.select(giftCandidateSelect(id)).from(giftsAndPayments).$dynamic(),
    )
      .where(
        and(
          donorFilter,
          sql`${giftsAndPayments.amount} >= ${staged.amount}::numeric - 0.01`,
          sql`${giftsAndPayments.amount} <= ${staged.amount}::numeric * 1.10 + 1`,
        ),
      )
      .orderBy(
        sql`ABS(${giftsAndPayments.amount} - ${staged.amount}::numeric) ASC`,
        sql`ABS(${giftsAndPayments.dateReceived} - ${staged.dateReceived}::date) ASC NULLS LAST`,
        desc(giftsAndPayments.dateReceived),
      )
      .limit(50);

    res.json({ data: rows });
  }),
);

// ─── GET /staged-payments/:id/gift-window ──────────────────────────────────
// Donor-AGNOSTIC entry point: existing gifts across ALL donors whose amount and
// date sit in a window around the staged payment. Lets a fundraiser reconcile
// to a gift even when the donor wasn't auto-resolved. Empty when no amount.
router.get(
  "/staged-payments/:id/gift-window",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const staged = await db
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!staged) return notFound(res, "staged payment");
    if (staged.amount == null) {
      res.json({ data: [] });
      return;
    }
    const days = Math.min(
      365,
      Math.max(
        1,
        Number(
          typeof req.query["days"] === "string" ? req.query["days"] : 30,
        ) || 30,
      ),
    );

    const dateClause = staged.dateReceived
      ? sql`AND (${giftsAndPayments.dateReceived} IS NULL OR ABS(${giftsAndPayments.dateReceived} - ${staged.dateReceived}::date) <= ${days})`
      : sql``;

    const rows = await giftCandidateJoins(
      db.select(giftCandidateSelect(id)).from(giftsAndPayments).$dynamic(),
    )
      .where(
        and(
          sql`${giftsAndPayments.amount} >= ${staged.amount}::numeric - 0.01`,
          sql`${giftsAndPayments.amount} <= ${staged.amount}::numeric * 1.10 + 1`,
          dateClause,
        ),
      )
      .orderBy(
        sql`ABS(${giftsAndPayments.amount} - ${staged.amount}::numeric) ASC`,
        sql`ABS(${giftsAndPayments.dateReceived} - ${staged.dateReceived}::date) ASC NULLS LAST`,
        desc(giftsAndPayments.dateReceived),
      )
      .limit(50);

    res.json({ data: rows });
  }),
);

// ─── GET /staged-payments-donor-search ─────────────────────────────────────
// Trigram donor search across organizations / people / households for the
// reconciler's manual donor picker.
router.get(
  "/staged-payments-donor-search",
  asyncHandler(async (req, res) => {
    const q =
      typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
    if (q.length < 2) {
      res.json({ data: [] });
      return;
    }
    const rows = (
      await db.execute(sql`
        SELECT id, kind, name, sim FROM (
          SELECT id, 'organization' AS kind, name AS name,
                 similarity(name, ${q}) AS sim
            FROM organizations WHERE name % ${q}
          UNION ALL
          SELECT id, 'person' AS kind, full_name AS name,
                 similarity(full_name, ${q}) AS sim
            FROM people WHERE full_name IS NOT NULL AND full_name % ${q}
          UNION ALL
          SELECT id, 'household' AS kind, name AS name,
                 similarity(name, ${q}) AS sim
            FROM households WHERE name % ${q}
        ) t
        ORDER BY sim DESC
        LIMIT 20
      `)
    ).rows as Array<{ id: string; kind: string; name: string }>;
    res.json({ data: rows });
  }),
);

export default router;
