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
} from "@workspace/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
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
import { donorboxEmittedStatus } from "../lib/derivedStatus";
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
import {
  bookDonorboxDonationApplication,
  donorboxLedgerGiftIdForDonation,
  donorboxLedgerCountedExistsForDonation,
  stripeLedgerGiftIdForCharge,
} from "../lib/paymentApplications";
import { giftHeaderColumns } from "./giftsAndPayments";

/**
 * Donorbox sync controls + (later) the new-money review queue and enrichment
 * surfaces. Donorbox is a pull-only source: Stripe-type donations enrich the
 * existing Stripe-sourced records (never mint), and non-Stripe donations become
 * human-reviewed new-money candidates. Sync triggers are admin-gated.
 */
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

// ─── POST /donorbox/sync ───────────────────────────────────────────────────
// On-demand pull. `fullResync: true` ignores the watermark and re-walks the full
// history, refreshing read-only facts even on already-resolved rows (review
// state is always preserved).
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
      const summary = await syncDonorbox({ fullResync });
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "Donorbox manual sync failed");
      res.status(502).json({
        error: "sync_failed",
        message: e instanceof Error ? e.message : "Donorbox sync failed",
      });
    }
  }),
);

// ─── GET /donorbox/sync-status ─────────────────────────────────────────────
router.get(
  "/donorbox/sync-status",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const state = await db
      .select()
      .from(donorboxSyncState)
      .where(eq(donorboxSyncState.id, DONORBOX_SYNC_STATE_ID))
      .then((r) => r[0] ?? null);
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

// ─── New-money review queue (non-Stripe Donorbox donations) ────────────────
//
// Only non-Stripe Donorbox donations are "new money": Stripe-type donations are
// already pulled by the Stripe sync (minting here would double-count), so they
// only ENRICH the existing Stripe record and never appear in this worklist.
// `donation_type IS DISTINCT FROM 'stripe'` (NULL counts as non-Stripe) AND
// `stripe_charge_id IS NULL` is the new-money predicate (the stripeChargeId
// guard is belt-and-suspenders so an enrichment-capable row can never surface
// here).
const newMoneyWhere = and(
  sql`${donorboxDonations.donationType} IS DISTINCT FROM 'stripe'`,
  isNull(donorboxDonations.stripeChargeId),
);

type ReviewQueue = "needs_review" | "done" | "excluded";

function reviewQueueWhere(queue: ReviewQueue) {
  switch (queue) {
    case "done":
      // Settled: linked to a pre-existing gift (reconciled) or minted a new one
      // (approved).
      return or(
        eq(donorboxDonations.status, "approved"),
        eq(donorboxDonations.status, "reconciled"),
      );
    case "excluded":
      return eq(donorboxDonations.status, "excluded");
    case "needs_review":
    default:
      return eq(donorboxDonations.status, "pending");
  }
}

function queueForStatus(status: string): ReviewQueue {
  if (status === "excluded") return "excluded";
  if (status === "approved" || status === "reconciled") return "done";
  return "needs_review";
}

// Escape LIKE/ILIKE wildcards so "%"/"_" search for those literal characters.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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

// One-to-one gift link (matched OR created) joined for display.
const linkedGift = alias(giftsAndPayments, "donorbox_linked_gift");

const reviewSelect = {
  id: donorboxDonations.id,
  donationType: donorboxDonations.donationType,
  paypalTransactionId: donorboxDonations.paypalTransactionId,
  amount: donorboxDonations.amount,
  amountRefunded: donorboxDonations.amountRefunded,
  processingFee: donorboxDonations.processingFee,
  currency: donorboxDonations.currency,
  donationStatus: donorboxDonations.donationStatus,
  refunded: donorboxDonations.refunded,
  recurring: donorboxDonations.recurring,
  donatedAt: donorboxDonations.donatedAt,
  dateReceived: donorboxDonations.dateReceived,
  campaignName: donorboxDonations.campaignName,
  designation: donorboxDonations.designation,
  comment: donorboxDonations.comment,
  anonymous: donorboxDonations.anonymous,
  donorName: donorboxDonations.donorName,
  donorEmail: donorboxDonations.donorEmail,
  donorEmployer: donorboxDonations.donorEmployer,
  status: donorboxDonations.status,
  exclusionReason: donorboxDonations.exclusionReason,
  matchStatus: donorboxDonations.matchStatus,
  matchScore: donorboxDonations.matchScore,
  matchMethod: donorboxDonations.matchMethod,
  organizationId: donorboxDonations.organizationId,
  individualGiverPersonId: donorboxDonations.individualGiverPersonId,
  householdId: donorboxDonations.householdId,
  matchedPaymentIntermediaryId: donorboxDonations.matchedPaymentIntermediaryId,
  createdAt: donorboxDonations.createdAt,
  updatedAt: donorboxDonations.updatedAt,
  // Shared donor display names + anonymous-masking helpers (stripped by
  // maskDonorDisplayFields before res.json).
  ...donorDisplayColumns,
  intermediaryName: paymentIntermediaries.name,
  linkedGiftId: linkedGift.id,
  linkedGiftName: linkedGift.name,
  linkedGiftAmount: linkedGift.amount,
  linkedGiftDate: linkedGift.dateReceived,
};

function reviewJoins<T extends PgSelect>(q: T) {
  return q
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
    .leftJoin(
      // Ledger read (pointer columns retired): the counted donorbox
      // application links the donation to its gift. Stripe-processed donations
      // (the vast majority) have no donorbox-sourced ledger row — their money
      // was booked against the STRIPE CHARGE — so fall back to the counted
      // stripe application for the donation's charge. One COALESCE, both
      // ledger authorities, no new pointer.
      linkedGift,
      sql`${linkedGift.id} = COALESCE(
        ${donorboxLedgerGiftIdForDonation()},
        ${stripeLedgerGiftIdForCharge(sql`${donorboxDonations.stripeChargeId}`)}
      )`,
    );
}

// Re-read one review row (with display joins, masked) — used as the action
// response so the client gets the same shape the list returns.
async function loadReviewRow(id: string, req: Request) {
  const viewer = getViewer(req);
  const rows = await reviewJoins(
    db.select(reviewSelect).from(donorboxDonations).$dynamic(),
  ).where(eq(donorboxDonations.id, id));
  const row = rows[0];
  if (!row) return null;
  return {
    ...maskDonorDisplayFields(row, viewer),
    queue: queueForStatus(row.status),
    // Donorbox keeps its STORED lifecycle column, but the API speaks the
    // shared derived vocabulary at the edge (approved/reconciled →
    // match_confirmed, rejected → excluded).
    status: donorboxEmittedStatus(row.status),
  };
}

function respondInvariant(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: issues.map((i) => i.message).join("; "),
    issues,
  });
}

// ─── GET /donorbox/review ──────────────────────────────────────────────────
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
        .then((r) => r[0]),
    ]);

    res.json({
      data: rows.map((row) => ({
        ...maskDonorDisplayFields(row, viewer),
        queue: queueForStatus(row.status),
        // Stored lifecycle → shared derived vocabulary at the API edge.
        status: donorboxEmittedStatus(row.status),
      })),
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

// Guard: the row must be a pending, non-Stripe new-money candidate. Returns a
// sent-response flag so the caller can early-return.
function rejectIfNotPendingNewMoney(
  res: Response,
  row: {
    status: string;
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

// ─── POST /donorbox/donations/:id/link-gift ────────────────────────────────
// Link a non-Stripe donation to an EXISTING gift as evidence (no new ledger
// row). Adopts the linked gift's donor (the human's explicit match overrides
// the auto-suggested donor), mirroring the QuickBooks/Stripe reconcile model.
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
        status: donorboxDonations.status,
        donationType: donorboxDonations.donationType,
        stripeChargeId: donorboxDonations.stripeChargeId,
      })
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, id))
      .then((r) => r[0]);
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
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    const NOT_PENDING = "__donorbox_link_not_pending__";
    try {
      await db.transaction(async (tx) => {
        // Lock the donation row so concurrent linkers serialize; read its amount
        // for the ledger booking.
        const locked = await tx
          .select({
            status: donorboxDonations.status,
            amount: donorboxDonations.amount,
          })
          .from(donorboxDonations)
          .where(eq(donorboxDonations.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked || locked.status !== "pending") {
          throw new Error(NOT_PENDING);
        }
        const [row] = await tx
          .update(donorboxDonations)
          .set({
            // Adopt the linked gift's donor (explicit human match wins).
            organizationId: gift.organizationId,
            individualGiverPersonId: gift.individualGiverPersonId,
            householdId: gift.householdId,
            status: "reconciled",
            matchStatus: "matched",
            matchMethod: "manual",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(donorboxDonations.id, id),
              eq(donorboxDonations.status, "pending"),
            ),
          )
          .returning({ id: donorboxDonations.id });
        if (!row) throw new Error(NOT_PENDING);
        // Dual-write (Phase 2): book the donation → gift ledger row. Donorbox
        // links are always human; delete-by-anchor keeps re-links idempotent.
        await bookDonorboxDonationApplication(tx, {
          donorboxDonationId: id,
          amount: locked.amount,
          giftId,
          confirmedByUserId: user.id,
          confirmedAt: new Date(),
          createdTheGift: false,
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message:
            "This Donorbox donation is no longer pending. Refresh and retry.",
        });
        return;
      }
      // Per-anchor/per-gift UNIQUE on the counted ledger — already linked.
      if (e instanceof Error && /23505|unique/i.test(e.message)) {
        res.status(409).json({
          error: "gift_already_linked",
          message: "That gift is already linked to another Donorbox donation.",
        });
        return;
      }
      throw e;
    }

    res.json(await loadReviewRow(id, req));
  }),
);

// ─── POST /donorbox/donations/:id/create-gift ──────────────────────────────
// Mint a NEW gift from a non-Stripe donation (Donor XOR), with a dedupe guard.
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
      .select()
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "donorbox donation");
    if (rejectIfNotPendingNewMoney(res, existing)) return;

    // Donor: the reviewer's explicit pick (any FK in the body) wins; otherwise
    // fall back to the seeded suggestion already on the row.
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

    // Dedupe guard: surface possible duplicates so the reviewer can link/exclude
    // instead of double-booking. Override with force=true.
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
          .then((r) => r[0]);
        const alreadyBooked = await tx
          .execute<{ booked: boolean }>(
            sql`SELECT ${donorboxLedgerCountedExistsForDonation(
              sql`${id}`,
            )} AS booked`,
          )
          .then((r) => r.rows[0]?.booked === true);
        if (
          !locked ||
          locked.status !== "pending" ||
          locked.donationType === "stripe" ||
          locked.stripeChargeId != null ||
          // Gift-link fact = the counted ledger row (pointer columns retired).
          alreadyBooked
        ) {
          throw new Error(NOT_PENDING);
        }
        // Re-validate against the FRESH (post-lock) donor: prefer the body pick,
        // else the row's current donor (a concurrent edit may have changed it).
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
        // Every gift needs at least one allocation (the sole home of money
        // scope). Seed a default full-amount line; fundraiser refines scope later.
        await seedInitialGiftAllocation(tx, {
          giftId,
          amount: locked.amount,
          dateReceived: locked.dateReceived,
        });
        await assertGiftHasAllocations(tx, giftId);
        await tx
          .update(donorboxDonations)
          .set({
            status: "approved",
            organizationId: lockedDonor.organizationId,
            individualGiverPersonId: lockedDonor.individualGiverPersonId,
            householdId: lockedDonor.householdId,
            matchedPaymentIntermediaryId: intermediaryId,
            matchStatus: "matched",
            matchMethod: "manual",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(donorboxDonations.id, id));
        // Dual-write (Phase 2): this donation MINTED the gift
        // (createdTheGift:true). Book the donation → gift ledger row.
        await bookDonorboxDonationApplication(tx, {
          donorboxDonationId: id,
          amount: locked.amount,
          giftId,
          confirmedByUserId: user.id,
          confirmedAt: new Date(),
          createdTheGift: true,
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message: "This Donorbox donation has already been resolved.",
        });
        return;
      }
      if (e instanceof Error && e.message === INVARIANT) {
        return respondInvariant(res, lockedIssues);
      }
      throw e;
    }

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

// Conservative dedupe: exact amount + date against active gifts and staged
// QuickBooks payments, plus any sibling Donorbox row with the same PayPal txn id
// that already booked a gift. Display-only — the reviewer decides.
async function findDonorboxDuplicates(d: {
  id: string;
  amount: string | null;
  dateReceived: string | null;
  paypalTransactionId: string | null;
}): Promise<DonorboxDuplicate[]> {
  const out: DonorboxDuplicate[] = [];
  if (d.amount != null && d.dateReceived != null) {
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
            eq(giftsAndPayments.amount, d.amount),
            eq(giftsAndPayments.dateReceived, d.dateReceived),
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
            eq(stagedPayments.amount, d.amount),
            eq(stagedPayments.dateReceived, d.dateReceived),
          ),
        )
        .limit(10),
    ]);
    for (const g of gifts) {
      out.push({
        kind: "gift",
        id: g.id,
        name: g.name,
        amount: g.amount,
        dateReceived: g.dateReceived,
        reason: "Same amount & date as an existing gift",
      });
    }
    for (const s of staged) {
      out.push({
        kind: "staged_payment",
        id: s.id,
        name: s.name,
        amount: s.amount,
        dateReceived: s.dateReceived,
        reason: "Same amount & date as a QuickBooks staged payment",
      });
    }
  }
  if (d.paypalTransactionId) {
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
          eq(donorboxDonations.paypalTransactionId, d.paypalTransactionId),
          ne(donorboxDonations.id, d.id),
          // Booked = has a counted ledger row (pointer columns retired).
          sql`${donorboxLedgerCountedExistsForDonation()}`,
        ),
      )
      .limit(10);
    for (const s of siblings) {
      out.push({
        kind: "donorbox",
        id: s.id,
        name: s.name,
        amount: s.amount,
        dateReceived: s.dateReceived,
        reason: "Same PayPal transaction already booked a gift",
      });
    }
  }
  return out;
}

// ─── POST /donorbox/donations/:id/exclude ──────────────────────────────────
// File a non-Stripe candidate out of the new-money worklist (pending → excluded,
// or reclassify an already-excluded row).
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
    const { exclusionReason } = parsed.data;

    const existing = await db
      .select({
        status: donorboxDonations.status,
        donationType: donorboxDonations.donationType,
        stripeChargeId: donorboxDonations.stripeChargeId,
      })
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "donorbox donation");
    if (existing.donationType === "stripe" || existing.stripeChargeId != null) {
      res.status(409).json({
        error: "not_new_money",
        message:
          "Stripe-type Donorbox donations are enrichment-only and cannot be excluded.",
      });
      return;
    }
    if (existing.status !== "pending" && existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excludable",
        message:
          "Only a pending or already-excluded Donorbox donation can be excluded.",
      });
      return;
    }

    const [row] = await db
      .update(donorboxDonations)
      .set({ status: "excluded", exclusionReason, updatedAt: new Date() })
      .where(
        and(
          eq(donorboxDonations.id, id),
          or(
            eq(donorboxDonations.status, "pending"),
            eq(donorboxDonations.status, "excluded"),
          ),
        ),
      )
      .returning({ id: donorboxDonations.id });
    if (!row) {
      res.status(409).json({
        error: "not_excludable",
        message: "This Donorbox donation can no longer be excluded. Refresh.",
      });
      return;
    }
    res.json(await loadReviewRow(id, req));
  }),
);

// ─── POST /donorbox/donations/:id/re-include ───────────────────────────────
// Move an excluded candidate back to pending.
router.post(
  "/donorbox/donations/:id/re-include",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const existing = await db
      .select({ status: donorboxDonations.status })
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "donorbox donation");
    if (existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excluded",
        message: "Only excluded Donorbox donations can be re-included.",
      });
      return;
    }
    const [row] = await db
      .update(donorboxDonations)
      .set({ status: "pending", exclusionReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(donorboxDonations.id, id),
          eq(donorboxDonations.status, "excluded"),
        ),
      )
      .returning({ id: donorboxDonations.id });
    if (!row) {
      res.status(409).json({
        error: "not_excluded",
        message:
          "This Donorbox donation is no longer excluded. Refresh and retry.",
      });
      return;
    }
    res.json(await loadReviewRow(id, req));
  }),
);

export default router;
