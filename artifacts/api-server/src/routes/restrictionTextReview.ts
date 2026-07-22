import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  giftAllocations,
  giftsAndPayments,
  pledgeAllocations,
  opportunitiesAndPledges,
  organizations,
  people,
  households,
} from "@workspace/db/schema";
import { count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { ListRestrictionTextReviewQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { asyncHandler, parseOrBadRequest, parsePagination } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

// Admin review list of allocations that still carry purpose_verbatim text after
// the automated restriction-text sort (migration 0150). Read-only: reviewers
// edit through the existing PATCH /gift-allocations/{id} and
// PATCH /pledge-allocations/{id} endpoints, which stay the single write path.

// Donor display name for a parent row that satisfies the donor-XOR invariant:
// exactly one of {organization, individual, household} is set.
const giftDonorNameExpr = sql<string | null>`COALESCE(
  (SELECT ${organizations.name} FROM ${organizations} WHERE ${organizations.id} = ${giftsAndPayments.organizationId}),
  (SELECT ${people.fullName} FROM ${people} WHERE ${people.id} = ${giftsAndPayments.individualGiverPersonId}),
  (SELECT ${households.name} FROM ${households} WHERE ${households.id} = ${giftsAndPayments.householdId})
)`;

const pledgeDonorNameExpr = sql<string | null>`COALESCE(
  (SELECT ${organizations.name} FROM ${organizations} WHERE ${organizations.id} = ${opportunitiesAndPledges.organizationId}),
  (SELECT ${people.fullName} FROM ${people} WHERE ${people.id} = ${opportunitiesAndPledges.individualGiverPersonId}),
  (SELECT ${households.name} FROM ${households} WHERE ${households.id} = ${opportunitiesAndPledges.householdId})
)`;

function giftQuery() {
  return db
    .select({
      allocationId: giftAllocations.id,
      source: sql<string>`'gift'`.as("source"),
      parentId: giftAllocations.giftId,
      parentName: giftsAndPayments.name,
      donorName: giftDonorNameExpr.as("donor_name"),
      subAmount: giftAllocations.subAmount,
      grantYear: giftAllocations.grantYear,
      purposeVerbatim: giftAllocations.purposeVerbatim,
      restrictionDescription: giftAllocations.restrictionDescription,
      updatedAt: giftAllocations.updatedAt,
    })
    .from(giftAllocations)
    .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
    .where(isNotNull(giftAllocations.purposeVerbatim));
}

function pledgeQuery() {
  return db
    .select({
      allocationId: pledgeAllocations.id,
      source: sql<string>`'pledge'`.as("source"),
      parentId: pledgeAllocations.pledgeOrOpportunityId,
      parentName: opportunitiesAndPledges.name,
      donorName: pledgeDonorNameExpr.as("donor_name"),
      subAmount: pledgeAllocations.subAmount,
      grantYear: pledgeAllocations.grantYear,
      purposeVerbatim: pledgeAllocations.purposeVerbatim,
      restrictionDescription: pledgeAllocations.restrictionDescription,
      updatedAt: pledgeAllocations.updatedAt,
    })
    .from(pledgeAllocations)
    .innerJoin(
      opportunitiesAndPledges,
      eq(opportunitiesAndPledges.id, pledgeAllocations.pledgeOrOpportunityId),
    )
    .where(isNotNull(pledgeAllocations.purposeVerbatim));
}

router.get(
  "/restriction-text-review",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = parseOrBadRequest(ListRestrictionTextReviewQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);

    const base =
      q.source === "gift"
        ? giftQuery()
        : q.source === "pledge"
          ? pledgeQuery()
          : unionAll(giftQuery(), pledgeQuery());
    const sub = base.as("review_rows");

    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(sub)
        .orderBy(desc(sub.updatedAt), desc(sub.allocationId))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(sub),
    ]);

    res.json({
      data: rows.map((r) => ({
        ...r,
        updatedAt: r.updatedAt.toISOString(),
      })),
      pagination: { page, limit, total: Number(total) },
    });
  }),
);

export default router;
