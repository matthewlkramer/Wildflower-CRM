import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  donorboxSyncState,
  DONORBOX_SYNC_STATE_ID,
  donorboxDonations,
  organizations,
  people,
  households,
  paymentIntermediaries,
  giftsAndPayments,
  stagedPayments,
  paymentApplications,
} from "@workspace/db/schema";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parsePagination,
} from "../lib/helpers";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "../lib/giftAllocationSeed";
import { getAppUser } from "../lib/appRequest";
import {
  donorboxStatusSql,
  donorboxStatusWhere,
  type DerivedStatus,
} from "../lib/derivedStatus";
import {
  donorboxDonationActiveGiftIdSql,
  getDonorboxDonationGiftRelationship,
} from "../lib/donorboxDonationLedger";
import { logger } from "../lib/logger";
import { syncDonorbox } from "../lib/donorboxSync";
import { isDonorboxConfigured } from "../lib/donorboxClient";
import {
  validateGiftInvariants,
  type InvariantIssue,
  LinkDonorboxDonationToGiftBody,
  CreateGiftFromDonorboxDonationBody,
  ExcludeDonorboxDonationBody,
} from "@workspace/api-zod";
import {
  donorDisplayColumns,
  maskDonorDisplayFields,
} from "../lib/donorJoinSelect";
import { getViewer } from "../lib/identityVisibility";
import { buildGiftValuesFromDonorbox } from "../lib/donorboxGift";
import { bookDonorboxDonationApplication } from "../lib/paymentApplications";
import { applyGiftQbTieMany } from "../lib/giftQbTie";
import { giftHeaderColumns } from "./giftsAndPayments";

const router: IRouter = Router();
router.use(requireAuth);

function requireAdmin(req: Request, res: Response): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

router.post(
  "/donorbox/sync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!isDonorboxConfigured()) {
      res.status(400).json({
        error: "not_configured",
        message: "Donorbox API credentials are not set.",
      });
      return;
    }
    const fullResync =
      req.body != null &&
      typeof req.body === "object" &&
      (req.body as { fullResync?: unknown }).fullResync === true;
    try {
      res.json(await syncDonorbox({ fullResync }));
    } catch (error) {
      logger.error({ err: error }, "Donorbox manual sync failed");
      res.status(502).json({
        error: "sync_failed",
        message: error instanceof Error ? error.message : "Donorbox sync failed",
      });
    }
  }),
);

router.get(
  "/donorbox/sync-status",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const state = await db
      .select()
      .from(donorboxSyncState)
      .where(eq(donorboxSyncState.id, DONORBOX_SYNC_STATE_ID))
      .then((rows) => rows[0] ?? null);
    res.json({
      configured: isDonorboxConfigured(),
      donationCursor: state?.donationCursor ?? null,
      lastRunStartedAt: state?.lastRunStartedAt ?? null,
      lastRunFinishedAt: state?.lastRunFinishedAt ?? null,
      lastStatus: state?.lastStatus ?? null,
      lastError: state?.lastError ?? null,
      donationsUpserted: state?.donationsUpserted ?? null,
      consecutiveErrors: state?.consecutiveErrors ?? 0,
    });
  }),
);

const newMoneyWhere = and(
  sql`${donorboxDonations.donationType} IS DISTINCT FROM 'stripe'`,
  isNull(donorboxDonations.stripeChargeId),
);

type ReviewQueue = "needs_review" | "done" | "excluded";

function reviewQueueWhere(queue: ReviewQueue) {
  switch (queue) {
    case "done":
      return donorboxStatusWhere.match_confirmed;
    case "excluded":
      return donorboxStatusWhere.excluded;
    case "needs_review":
    default:
      return or(
        donorboxStatusWhere.pending,
        donorboxStatusWhere.match_proposed,
      );
  }
}

function queueForStatus(status: DerivedStatus): ReviewQueue {
  if (status === "excluded") return "excluded";
  if (status === "match_confirmed") return "done";
  return "needs_review";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function reviewSearchWhere(term: string) {
  const like = `%${escapeLike(term)}%`;
  return or(
    ilike(donorboxDonations.donorName, like),
    ilike(donorboxDonations.donorEmail, like),
    ilike(donorboxDonations.comment, like),
    ilike(donorboxDonations.designation, like),
    ilike(donorboxDonations.campaignName, like),
  );
}

const linkedGift = alias(giftsAndPayments, "donorbox_linked_gift");
const activeGiftId = donorboxDonationActiveGiftIdSql(
  sql`${donorboxDonations.id}`,
);
const { raw: _raw, ...donationColumns } = getTableColumns(donorboxDonations);

const reviewSelect = {
  ...donationColumns,
  status: donorboxStatusSql,
  ...donorDisplayColumns,
  intermediaryName: paymentIntermediaries.name,
  linkedGiftId: linkedGift.id,
  linkedGiftName: linkedGift.name,
  linkedGiftAmount: linkedGift.amount,
  linkedGiftDate: linkedGift.dateReceived,
};

function reviewJoins<T extends PgSelect>(query: T) {
  return query
    .leftJoin(
      organizations,
      eq(organizations.id, donorboxDonations.organizationId),
    )
    .leftJoin(households, eq(households.id, donorboxDonations.householdId))
    .leftJoin(
      people,
      eq(people.id, donorboxDonations.individualGiverPersonId),
    )
    .leftJoin(
      paymentIntermediaries,
      eq(
        paymentIntermediaries.id,
        donorboxDonations.matchedPaymentIntermediaryId,
      ),
    )
    .leftJoin(linkedGift, sql`${linkedGift.id} = ${activeGiftId}`);
}

async function loadReviewRow(id: string, req: Request) {
  const rows = await reviewJoins(
    db.select(reviewSelect).from(donorboxDonations).$dynamic(),
  ).where(eq(donorboxDonations.id, id));
  const row = rows[0];
  if (!row) return null;
  return {
    ...maskDonorDisplayFields(row, getViewer(req)),
    queue: queueForStatus(row.status),
  };
}

function respondInvariant(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: issues.map((issue) => issue.message).join("; "),
    issues,
  });
}

router.get(
  "/donorbox/review",
  asyncHandler(async (req, res) => {
    const viewer = getViewer(req);
    const queueParam = (req.query.queue as string | undefined) ?? "needs_review";
    const queue: ReviewQueue =
      queueParam === "done" || queueParam === "excluded"
        ? queueParam
        : "needs_review";
    const search =
      typeof req.query.search === "string" && req.query.search.trim().length
        ? req.query.search.trim()
        : null;
    const { limit, page, offset } = parsePagination({
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
    });
    const where = and(
      newMoneyWhere,
      reviewQueueWhere(queue),
      ...(search ? [reviewSearchWhere(search)] : []),
    );

    const [rows, totalRow] = await Promise.all([
      reviewJoins(db.select(reviewSelect).from(donorboxDonations).$dynamic())
        .where(where)
        .orderBy(
          desc(donorboxDonations.dateReceived),
          desc(donorboxDonations.createdAt),
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(donorboxDonations)
        .where(where)
        .then((result) => result[0]),
    ]);

    res.json({
      data: rows.map((row) => ({
        ...maskDonorDisplayFields(row, viewer),
        queue: queueForStatus(row.status),
      })),
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

function rejectIfNotPendingNewMoney(
  res: Response,
  row: {
    status: DerivedStatus;
    donationType: string | null;
    stripeChargeId: string | null;
  },
): boolean {
  if (row.donationType === "stripe" || row.stripeChargeId != null) {
    res.status(409).json({
      error: "not_new_money",
      message:
        "Stripe-type Donorbox donations enrich the existing Stripe record and are not new-money candidates.",
    });
    return true;
  }
  if (row.status !== "pending") {
    res.status(409).json({
      error: "not_pending",
      message: "This Donorbox donation has already been resolved.",
    });
    return true;
  }
  return false;
}

async function giftHasAnotherActiveDonorboxOwner(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  giftId: string,
  donationId: string,
): Promise<boolean> {
  return tx
    .select({ id: paymentApplications.id })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.giftId, giftId),
        eq(paymentApplications.evidenceSource, "donorbox"),
        eq(paymentApplications.linkRole, "counted"),
        sql`${paymentApplications.lifecycle} IN ('proposed', 'confirmed')`,
        ne(paymentApplications.donorboxDonationId, donationId),
      ),
    )
    .limit(1)
    .then((rows) => rows.length > 0);
}

router.post(
  "/donorbox/donations/:id/link-gift",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = LinkDonorboxDonationToGiftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { giftId } = parsed.data;

    const existing = await db
      .select({
        status: donorboxStatusSql,
        donationType: donorboxDonations.donationType,
        stripeChargeId: donorboxDonations.stripeChargeId,
      })
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, id))
      .then((rows) => rows[0]);
    if (!existing) return notFound(res, "donorbox donation");
    if (rejectIfNotPendingNewMoney(res, existing)) return;

    const gift = await db
      .select({
        id: giftsAndPayments.id,
        organizationId: giftsAndPayments.organizationId,
        individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
        householdId: giftsAndPayments.householdId,
      })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .then((rows) => rows[0]);
    if (!gift) return notFound(res, "gift");

    const NOT_PENDING = "__donorbox_link_not_pending__";
    const GIFT_LINKED = "__donorbox_gift_already_linked__";
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select({
            id: donorboxDonations.id,
            amount: donorboxDonations.amount,
            donationType: donorboxDonations.donationType,
            stripeChargeId: donorboxDonations.stripeChargeId,
            exclusionReason: donorboxDonations.exclusionReason,
          })
          .from(donorboxDonations)
          .where(eq(donorboxDonations.id, id))
          .for("update")
          .then((rows) => rows[0]);
        const relationship = locked
          ? await getDonorboxDonationGiftRelationship(tx, id, {
              includeProposed: true,
            })
          : null;
        if (
          !locked ||
          locked.donationType === "stripe" ||
          locked.stripeChargeId != null ||
          locked.exclusionReason != null ||
          relationship != null
        ) {
          throw new Error(NOT_PENDING);
        }
        if (await giftHasAnotherActiveDonorboxOwner(tx, giftId, id)) {
          throw new Error(GIFT_LINKED);
        }

        const now = new Date();
        await tx
          .update(donorboxDonations)
          .set({
            organizationId: gift.organizationId,
            individualGiverPersonId: gift.individualGiverPersonId,
            householdId: gift.householdId,
            matchStatus: "matched",
            matchMethod: "manual",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: now,
            approvedByUserId: user.id,
            approvedAt: now,
            updatedAt: now,
          })
          .where(eq(donorboxDonations.id, id));
        await bookDonorboxDonationApplication(tx, {
          donorboxDonationId: id,
          amount: locked.amount,
          giftId,
          confirmedByUserId: user.id,
          confirmedAt: now,
          createdTheGift: false,
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message:
            "This Donorbox donation is no longer pending. Refresh and retry.",
        });
        return;
      }
      if (error instanceof Error && error.message === GIFT_LINKED) {
        res.status(409).json({
          error: "gift_already_linked",
          message: "That gift is already linked to another Donorbox donation.",
        });
        return;
      }
      throw error;
    }

    await applyGiftQbTieMany(giftId);
    res.json(await loadReviewRow(id, req));
  }),
);

router.post(
  "/donorbox/donations/:id/create-gift",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = CreateGiftFromDonorboxDonationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const body = parsed.data;

    const existing = await db
      .select({
        ...getTableColumns(donorboxDonations),
        derivedStatus: donorboxStatusSql,
      })
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, id))
      .then((rows) => rows[0]);
    if (!existing) return notFound(res, "donorbox donation");
    if (
      rejectIfNotPendingNewMoney(res, {
        status: existing.derivedStatus,
        donationType: existing.donationType,
        stripeChargeId: existing.stripeChargeId,
      })
    ) {
      return;
    }

    const bodyHasDonor =
      body.organizationId != null ||
      body.individualGiverPersonId != null ||
      body.householdId != null;
    const donor = bodyHasDonor
      ? {
          organizationId: body.organizationId ?? null,
          individualGiverPersonId: body.individualGiverPersonId ?? null,
          householdId: body.householdId ?? null,
        }
      : {
          organizationId: existing.organizationId,
          individualGiverPersonId: existing.individualGiverPersonId,
          householdId: existing.householdId,
        };
    const preIssues = validateGiftInvariants(donor);
    if (preIssues.length) return respondInvariant(res, preIssues);

    const intermediaryId =
      body.paymentIntermediaryId ?? existing.matchedPaymentIntermediaryId;
    if (!body.force) {
      const candidates = await findDonorboxDuplicates({
        id: existing.id,
        amount: existing.amount,
        dateReceived: existing.dateReceived,
        paypalTransactionId: existing.paypalTransactionId,
      });
      if (candidates.length) {
        res.status(409).json({
          error: "possible_duplicate",
          message:
            "Possible duplicate(s) found — link to an existing gift or exclude, or resubmit with force=true to mint anyway.",
          candidates,
        });
        return;
      }
    }

    const giftId = newId();
    const NOT_PENDING = "__donorbox_not_pending__";
    const INVARIANT = "__donorbox_invariant__";
    let lockedIssues: InvariantIssue[] = [];
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(donorboxDonations)
          .where(eq(donorboxDonations.id, id))
          .for("update")
          .then((rows) => rows[0]);
        const relationship = locked
          ? await getDonorboxDonationGiftRelationship(tx, id, {
              includeProposed: true,
            })
          : null;
        if (
          !locked ||
          locked.donationType === "stripe" ||
          locked.stripeChargeId != null ||
          locked.exclusionReason != null ||
          relationship != null
        ) {
          throw new Error(NOT_PENDING);
        }

        const lockedDonor = bodyHasDonor
          ? donor
          : {
              organizationId: locked.organizationId,
              individualGiverPersonId: locked.individualGiverPersonId,
              householdId: locked.householdId,
            };
        const issues = validateGiftInvariants(lockedDonor);
        if (issues.length) {
          lockedIssues = issues;
          throw new Error(INVARIANT);
        }

        await tx.insert(giftsAndPayments).values(
          buildGiftValuesFromDonorbox(
            giftId,
            {
              id: locked.id,
              donationType: locked.donationType,
              amount: locked.amount,
              dateReceived: locked.dateReceived,
              donorName: locked.donorName,
              campaignName: locked.campaignName,
              organizationId: lockedDonor.organizationId,
              individualGiverPersonId: lockedDonor.individualGiverPersonId,
              householdId: lockedDonor.householdId,
              matchedPaymentIntermediaryId: intermediaryId,
            },
            user.id,
          ),
        );
        await seedInitialGiftAllocation(tx, {
          giftId,
          amount: locked.amount,
          dateReceived: locked.dateReceived,
        });
        await assertGiftHasAllocations(tx, giftId);

        const now = new Date();
        await tx
          .update(donorboxDonations)
          .set({
            organizationId: lockedDonor.organizationId,
            individualGiverPersonId: lockedDonor.individualGiverPersonId,
            householdId: lockedDonor.householdId,
            matchedPaymentIntermediaryId: intermediaryId,
            matchStatus: "matched",
            matchMethod: "manual",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: now,
            approvedByUserId: user.id,
            approvedAt: now,
            updatedAt: now,
          })
          .where(eq(donorboxDonations.id, id));
        await bookDonorboxDonationApplication(tx, {
          donorboxDonationId: id,
          amount: locked.amount,
          giftId,
          confirmedByUserId: user.id,
          confirmedAt: now,
          createdTheGift: true,
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message: "This Donorbox donation has already been resolved.",
        });
        return;
      }
      if (error instanceof Error && error.message === INVARIANT) {
        return respondInvariant(res, lockedIssues);
      }
      throw error;
    }

    await applyGiftQbTieMany(giftId);
    const [gift] = await db
      .select(giftHeaderColumns)
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId));
    res.status(201).json({ gift, donationId: id });
  }),
);

interface DonorboxDuplicate {
  kind: "gift" | "staged_payment" | "donorbox";
  id: string;
  name: string | null;
  amount: string | null;
  dateReceived: string | null;
  reason: string | null;
}

async function findDonorboxDuplicates(donation: {
  id: string;
  amount: string | null;
  dateReceived: string | null;
  paypalTransactionId: string | null;
}): Promise<DonorboxDuplicate[]> {
  const duplicates: DonorboxDuplicate[] = [];
  if (donation.amount != null && donation.dateReceived != null) {
    const [gifts, staged] = await Promise.all([
      db
        .select({
          id: giftsAndPayments.id,
          name: giftsAndPayments.name,
          amount: giftsAndPayments.amount,
          dateReceived: giftsAndPayments.dateReceived,
        })
        .from(giftsAndPayments)
        .where(
          and(
            eq(giftsAndPayments.amount, donation.amount),
            eq(giftsAndPayments.dateReceived, donation.dateReceived),
            isNull(giftsAndPayments.archivedAt),
          ),
        )
        .limit(10),
      db
        .select({
          id: stagedPayments.id,
          name: stagedPayments.payerName,
          amount: stagedPayments.amount,
          dateReceived: stagedPayments.dateReceived,
        })
        .from(stagedPayments)
        .where(
          and(
            eq(stagedPayments.amount, donation.amount),
            eq(stagedPayments.dateReceived, donation.dateReceived),
          ),
        )
        .limit(10),
    ]);
    for (const gift of gifts) {
      duplicates.push({
        kind: "gift",
        id: gift.id,
        name: gift.name,
        amount: gift.amount,
        dateReceived: gift.dateReceived,
        reason: "Same amount & date as an existing gift",
      });
    }
    for (const payment of staged) {
      duplicates.push({
        kind: "staged_payment",
        id: payment.id,
        name: payment.name,
        amount: payment.amount,
        dateReceived: payment.dateReceived,
        reason: "Same amount & date as a QuickBooks staged payment",
      });
    }
  }

  if (donation.paypalTransactionId) {
    const siblings = await db
      .select({
        id: donorboxDonations.id,
        name: donorboxDonations.donorName,
        amount: donorboxDonations.amount,
        dateReceived: donorboxDonations.dateReceived,
      })
      .from(donorboxDonations)
      .where(
        and(
          eq(
            donorboxDonations.paypalTransactionId,
            donation.paypalTransactionId,
          ),
          ne(donorboxDonations.id, donation.id),
          sql`EXISTS (
            SELECT 1 FROM payment_applications pa
            WHERE pa.donorbox_donation_id = ${donorboxDonations.id}
              AND pa.evidence_source = 'donorbox'
              AND pa.link_role = 'counted'
              AND pa.lifecycle = 'confirmed'
          )`,
        ),
      )
      .limit(10);
    for (const sibling of siblings) {
      duplicates.push({
        kind: "donorbox",
        id: sibling.id,
        name: sibling.name,
        amount: sibling.amount,
        dateReceived: sibling.dateReceived,
        reason: "Same PayPal transaction already booked a gift",
      });
    }
  }
  return duplicates;
}

router.post(
  "/donorbox/donations/:id/exclude",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = ExcludeDonorboxDonationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    const NOT_EXCLUDABLE = "__donorbox_not_excludable__";
    const NOT_NEW_MONEY = "__donorbox_not_new_money__";
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select({
            donationType: donorboxDonations.donationType,
            stripeChargeId: donorboxDonations.stripeChargeId,
            exclusionReason: donorboxDonations.exclusionReason,
          })
          .from(donorboxDonations)
          .where(eq(donorboxDonations.id, id))
          .for("update")
          .then((rows) => rows[0]);
        if (!locked) throw new Error(NOT_EXCLUDABLE);
        if (locked.donationType === "stripe" || locked.stripeChargeId != null) {
          throw new Error(NOT_NEW_MONEY);
        }
        const relationship = await getDonorboxDonationGiftRelationship(tx, id, {
          includeProposed: true,
        });
        if (relationship != null) throw new Error(NOT_EXCLUDABLE);

        await tx
          .update(donorboxDonations)
          .set({
            status: "excluded",
            exclusionReason: parsed.data.exclusionReason,
            updatedAt: new Date(),
          })
          .where(eq(donorboxDonations.id, id));
      });
    } catch (error) {
      if (error instanceof Error && error.message === NOT_NEW_MONEY) {
        res.status(409).json({
          error: "not_new_money",
          message:
            "Stripe-type Donorbox donations are enrichment-only and cannot be excluded.",
        });
        return;
      }
      if (error instanceof Error && error.message === NOT_EXCLUDABLE) {
        res.status(409).json({
          error: "not_excludable",
          message:
            "Only a Donorbox donation without an active gift application can be excluded.",
        });
        return;
      }
      throw error;
    }
    res.json(await loadReviewRow(id, req));
  }),
);

router.post(
  "/donorbox/donations/:id/re-include",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const [row] = await db
      .update(donorboxDonations)
      .set({ status: "pending", exclusionReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(donorboxDonations.id, id),
          donorboxStatusWhere.excluded,
        ),
      )
      .returning({ id: donorboxDonations.id });
    if (!row) {
      const exists = await db
        .select({ id: donorboxDonations.id })
        .from(donorboxDonations)
        .where(eq(donorboxDonations.id, id))
        .then((rows) => rows[0]);
      if (!exists) return notFound(res, "donorbox donation");
      res.status(409).json({
        error: "not_excluded",
        message: "Only excluded Donorbox donations can be re-included.",
      });
      return;
    }
    res.json(await loadReviewRow(id, req));
  }),
);

export default router;
