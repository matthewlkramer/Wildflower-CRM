import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  giftsAndPayments,
  giftAllocations,
  organizations,
  people,
  households,
  opportunitiesAndPledges,
} from "@workspace/db/schema";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { asyncHandler } from "../../lib/helpers";
import { getViewer, maskName } from "../../lib/identityVisibility";
import { escapeLike } from "../quickbooks/shared";
import {
  BOOKABLE_REASON_LABELS,
  deriveGiftBookable,
  giftIsIncompleteExpr,
  giftReportRequiredExpr,
  giftHasReportingTaskExpr,
  type BookableGiftAllocationInput,
} from "../../lib/bookableGift";
import { personDisplayNameSql } from "../../lib/personNameSql";

const router: IRouter = Router();

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Canonical person display chain (full → first+last → nickname); see
// lib/personNameSql.ts.
const personNameSql = personDisplayNameSql(people);

// ─── GET /reconciliation/incomplete-gifts ───────────────────────────────────
// The bookable-gift SOP worklist (Task #585). ONE ROW PER gift that fails the
// bookable-gift standard — the critical coding info the finance team needs to
// book it correctly in QuickBooks. The SQL filter (giftIsIncompleteExpr) and the
// per-row reasons (deriveGiftBookable) are two halves of ONE standard kept in
// lockstep in lib/bookableGift.ts, so the queue and the reasons never disagree.
// Off-books gifts are exempt. Read-only; the fix happens on the gift detail page.
router.get(
  "/reconciliation/incomplete-gifts",
  asyncHandler(async (req, res) => {
    const viewer = getViewer(req);
    const q = (typeof req.query["q"] === "string" ? req.query["q"] : "").trim();
    const entityId =
      typeof req.query["entityId"] === "string" ? req.query["entityId"] : null;
    const limit = clampInt(req.query["limit"], 50, 1, 200);
    const offset = clampInt(req.query["offset"], 0, 0, 1_000_000);

    const conds: SQL[] = [
      isNull(giftsAndPayments.archivedAt),
      giftIsIncompleteExpr(),
    ];

    if (q.length >= 2) {
      const like = `%${escapeLike(q)}%`;
      conds.push(
        or(
          ilike(organizations.name, like),
          ilike(people.fullName, like),
          sql`TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})) ILIKE ${like}`,
          ilike(households.name, like),
        )!,
      );
    }
    if (entityId) {
      conds.push(
        sql`EXISTS (
          SELECT 1 FROM ${giftAllocations} ga
          WHERE ga.gift_id = ${giftsAndPayments.id}
            AND ga.entity_id = ${entityId}
        )`,
      );
    }

    const where = and(...conds);

    const [rows, totalRow] = await Promise.all([
      db
        .select({
          id: giftsAndPayments.id,
          giftName: giftsAndPayments.name,
          amount: giftsAndPayments.amount,
          dateReceived: giftsAndPayments.dateReceived,
          grantLetterUrl: giftsAndPayments.grantLetterUrl,
          sourceRecordUrl: giftsAndPayments.sourceRecordUrl,
          organizationId: giftsAndPayments.organizationId,
          individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
          householdId: giftsAndPayments.householdId,
          organizationName: organizations.name,
          organizationAnonymous: organizations.anonymous,
          organizationOwnerUserId: organizations.ownerUserId,
          personName: personNameSql,
          personAnonymous: people.anonymous,
          personOwnerUserId: people.ownerUserId,
          householdName: households.name,
          opportunityId: giftsAndPayments.opportunityId,
          opportunityName: opportunitiesAndPledges.name,
          reportRequired: giftReportRequiredExpr(),
          hasReportingTask: giftHasReportingTaskExpr(),
        })
        .from(giftsAndPayments)
        .leftJoin(
          organizations,
          eq(organizations.id, giftsAndPayments.organizationId),
        )
        .leftJoin(
          people,
          eq(people.id, giftsAndPayments.individualGiverPersonId),
        )
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(
          opportunitiesAndPledges,
          eq(opportunitiesAndPledges.id, giftsAndPayments.opportunityId),
        )
        .where(where)
        .orderBy(desc(giftsAndPayments.dateReceived), desc(giftsAndPayments.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .leftJoin(
          organizations,
          eq(organizations.id, giftsAndPayments.organizationId),
        )
        .leftJoin(
          people,
          eq(people.id, giftsAndPayments.individualGiverPersonId),
        )
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .where(where)
        .then((r) => r[0]),
    ]);

    // Fetch the page's allocations in one query so the per-gift reasons come
    // from the SAME allocation scope the filter tested.
    const giftIds = rows.map((r) => r.id);
    const allocRows = giftIds.length
      ? await db
          .select({
            giftId: giftAllocations.giftId,
            entityId: giftAllocations.entityId,
            grantYear: giftAllocations.grantYear,
            intendedUsage: giftAllocations.intendedUsage,
            fundableProjectId: giftAllocations.fundableProjectId,
            regionalRestrictionType: giftAllocations.regionalRestrictionType,
            otherRestrictionType: giftAllocations.otherRestrictionType,
            timeRestrictionType: giftAllocations.timeRestrictionType,
          })
          .from(giftAllocations)
          .where(inArray(giftAllocations.giftId, giftIds))
      : [];

    const allocsByGift = new Map<string, BookableGiftAllocationInput[]>();
    for (const a of allocRows) {
      if (!a.giftId) continue;
      const list = allocsByGift.get(a.giftId) ?? [];
      list.push({
        entityId: a.entityId,
        grantYear: a.grantYear,
        intendedUsage: a.intendedUsage,
        fundableProjectId: a.fundableProjectId,
        regionalRestrictionType: a.regionalRestrictionType,
        otherRestrictionType: a.otherRestrictionType,
        timeRestrictionType: a.timeRestrictionType,
      });
      allocsByGift.set(a.giftId, list);
    }

    const data = rows.map((r) => {
      let donorName: string | null = null;
      let donorKind: "organization" | "person" | "household" | null = null;
      if (r.organizationId) {
        donorKind = "organization";
        donorName = maskName(
          r.organizationName,
          {
            anonymous: r.organizationAnonymous,
            ownerUserId: r.organizationOwnerUserId,
          },
          viewer,
        );
      } else if (r.individualGiverPersonId) {
        donorKind = "person";
        donorName = maskName(
          r.personName,
          { anonymous: r.personAnonymous, ownerUserId: r.personOwnerUserId },
          viewer,
        );
      } else if (r.householdId) {
        donorKind = "household";
        donorName = r.householdName;
      }

      const { reasons } = deriveGiftBookable({
        organizationId: r.organizationId,
        individualGiverPersonId: r.individualGiverPersonId,
        householdId: r.householdId,
        amount: r.amount,
        dateReceived: r.dateReceived,
        grantLetterUrl: r.grantLetterUrl,
        sourceRecordUrl: r.sourceRecordUrl,
        // The query already excludes off-books gifts (giftIsIncompleteExpr).
        isOffBooks: false,
        allocations: allocsByGift.get(r.id) ?? [],
        reportRequired: Boolean(r.reportRequired),
        hasReportingDeadlineTask: Boolean(r.hasReportingTask),
      });

      return {
        id: r.id,
        giftName: r.giftName,
        donorName,
        donorKind,
        amount: r.amount,
        dateReceived: r.dateReceived,
        opportunityId: r.opportunityId,
        opportunityName: r.opportunityName,
        reasons,
        reasonLabels: reasons.map((x) => BOOKABLE_REASON_LABELS[x]),
      };
    });

    res.json({
      data,
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total: totalRow?.value ?? 0,
      },
    });
  }),
);

export default router;
