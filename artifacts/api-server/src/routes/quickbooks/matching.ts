import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  stagedPaymentSplits,
  giftsAndPayments,
  giftAllocations,
  paymentApplications,
} from "@workspace/db/schema";
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { asyncHandler, newId, notFound, paramId } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import {
  ReconcileStagedPaymentBody,
  GroupReconcileStagedPaymentsBody,
  ConfirmStagedPaymentMatchesBody,
  SplitStagedPaymentBody,
  validateGiftInvariants,
} from "@workspace/api-zod";
import { donorOf, hasExactlyOneDonor } from "../../lib/quickbooksLink";
import { applyGiftQbTieMany } from "../../lib/giftQbTie";
import { buildGiftValuesFromStaged } from "../../lib/quickbooksGift";
import {
  stampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "../../lib/giftFinalAmount";
import {
  applyPaymentApplication,
  confirmPaymentApplicationsForPayment,
  qbLedgerExistsForGiftExcludingPayment,
} from "../../lib/paymentApplications";
import { stagedReturnColumns } from "./shared";
import { giftHeaderColumns } from "../giftsAndPayments";

const router: IRouter = Router();

// ─── POST /staged-payments/:id/reconcile ───────────────────────────────────
// Tie a staged payment to an EXISTING gift (no new gift minted). Sets
// matchedGiftId → the chosen gift, status approved, autoApplied=false. An
// explicit human Match treats the selected gift as authoritative: the staged
// row ADOPTS the gift's donor, overriding any auto-guessed donor. Guards: row
// pending, gift exists with a single valid donor, gift not already linked.
router.post(
  "/staged-payments/:id/reconcile",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = ReconcileStagedPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { giftId, allocationId } = parsed.data;

    const existing = await db
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.sourceGroupId != null) {
      res.status(409).json({
        error: "source_group_member",
        message:
          "This payment is part of a group. Reconcile the whole group from its card.",
      });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment has already been resolved.",
      });
      return;
    }

    const gift = await db
      .select(giftHeaderColumns)
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    // An explicit human Match treats the selected gift as authoritative: adopt
    // the gift's donor onto the staged row, overriding any auto-guessed donor
    // (e.g. a deposit auto-matched to an individual can link to that person's
    // household gift). Guard only that the gift itself carries a single valid
    // donor so the staged row keeps the Donor XOR invariant.
    const giftDonor = donorOf(gift);
    if (!hasExactlyOneDonor(giftDonor)) {
      res.status(400).json({
        error: "link_invalid",
        message: "Cannot reconcile this staged payment to that gift.",
        details: {
          issues: [
            {
              path: ["giftId"],
              message: "The selected gift has no donor to adopt.",
            },
          ],
        },
      });
      return;
    }
    const finalDonor = giftDonor;

    // Optional allocation-scoping: a reviewer can narrow the link to one of the
    // gift's allocations (the CRM-only worklist's "Link allocation → payment"
    // action). The allocation must belong to this gift; otherwise it is a stale
    // / cross-gift id and we refuse rather than record a meaningless pointer.
    if (allocationId != null) {
      const alloc = await db
        .select({ id: giftAllocations.id })
        .from(giftAllocations)
        .where(
          and(
            eq(giftAllocations.id, allocationId),
            eq(giftAllocations.giftId, giftId),
          ),
        )
        .then((r) => r[0]);
      if (!alloc) {
        res.status(400).json({
          error: "link_invalid",
          message: "Cannot reconcile this staged payment to that allocation.",
          details: {
            issues: [
              {
                path: ["allocationId"],
                message: "The allocation does not belong to the selected gift.",
              },
            ],
          },
        });
        return;
      }
    }

    // Atomic: only succeeds if still pending AND no other staged row has grabbed
    // this gift (matched, created, group-reconciled OR split-linked) since the
    // pre-check. The NOT EXISTS guards handle the common case and the
    // partial-unique index on matched_gift_id backstops a same-table write-skew,
    // but the split table has no shared unique with staged_payments, so the
    // cross-table invariant (a gift is claimed in exactly one place) is enforced
    // by taking the gift row FOR UPDATE first. Every gift-claiming path (this
    // reconcile, group-reconcile, split) locks staged-then-gift in that order so
    // they serialize on the gift row without deadlocking.
    let updated: Array<{ id: string }> = [];
    try {
      await db.transaction(async (tx) => {
        await tx
          .select({ id: stagedPayments.id })
          .from(stagedPayments)
          .where(eq(stagedPayments.id, id))
          .for("update");
        await tx
          .select({ id: giftsAndPayments.id })
          .from(giftsAndPayments)
          .where(eq(giftsAndPayments.id, giftId))
          .for("update");
        updated = await tx
          .update(stagedPayments)
          .set({
            ...finalDonor,
            // The new model: this staged row is permanent EVIDENCE tied to the
            // gift, never archived and never a second gift. `reconciled` (not
            // `approved`) marks that terminal tie.
            status: "reconciled",
            matchedGiftId: giftId,
            createdGiftId: null,
            autoApplied: false,
            matchStatus: "matched",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stagedPayments.id, id),
              eq(stagedPayments.status, "pending"),
              // Gift must not already be QB-linked to another staged payment.
              // The ledger unifies direct + split + group-reconciled links, so
              // one existence check replaces the legacy direct + split guards.
              sql`NOT ${qbLedgerExistsForGiftExcludingPayment(sql`${giftId}`, sql`${id}`)}`,
            ),
          )
          .returning({ id: stagedPayments.id });

        // Tie succeeded → this QB evidence is now the gift's final-amount source
        // (unless the gift is already Stripe-sourced, in which case the stamp is
        // a no-op: Stripe GROSS wins). Rebalance the single allocation, or flag
        // a multi-allocation gift whose splits no longer sum.
        if (updated.length > 0) {
          const stamp = await stampGiftFinalAmount(tx, giftId, {
            source: "quickbooks",
            qbStagedPaymentId: id,
            amount: existing.amount,
          });
          if (!stamp.skipped) {
            await adjustSingleAllocationOrFlag(
              tx,
              giftId,
              stamp.oldAmount,
              stamp.newAmount,
              "quickbooks",
            );
          }

          // Dual-write (Phase 2): book the QB cash-application ledger row. This
          // staged payment fully applies to the matched gift (1:1 link).
          if (existing.amount && Number(existing.amount) > 0) {
            await applyPaymentApplication(tx, {
              paymentId: id,
              giftId,
              giftAllocationId: allocationId ?? null,
              amountApplied: existing.amount,
              evidenceSource: "quickbooks",
              matchMethod: "human",
              confirmedByUserId: user.id,
              confirmedAt: new Date(),
              createdTheGift: false,
            });
          }
        }
      });
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code?: string }).code === "23505"
      ) {
        res.status(409).json({
          error: "link_conflict",
          message:
            "That gift was just linked to another payment. Refresh and try again.",
        });
        return;
      }
      throw e;
    }

    if (updated.length === 0) {
      res.status(409).json({
        error: "link_conflict",
        message:
          "This staged payment is no longer pending, or that gift was just linked to another payment. Refresh and try again.",
      });
      return;
    }

    // The gift now carries QB linkage — persist its tie status.
    await applyGiftQbTieMany(giftId);

    res.json({ gift, stagedPaymentId: id });
  }),
);

// ─── POST /staged-payments/group-reconcile ─────────────────────────────────
// Manually group several staged payments into a single unit and reconcile the
// GROUP to ONE existing CRM gift (which typically carries multiple allocations).
// Members must form one coherent group: either they share ONE underlying bank
// Deposit (qbDepositId), or they share the same payer name (a single wire, or a
// series of stock sales, split across several QB records — each often settling
// as its OWN bank deposit over several days). No new gift is minted and
// QuickBooks is never written back. Guards: at least two rows; every row pending
// and not already resolved; all rows share one grouping key (deposit, or payer);
// when the rows span more than one date_received OR more than one distinct
// deposit the caller must pass confirmMultiDate; the gift exists with a single
// valid donor and is not
// already linked to any other staged row; the members' combined total sits in
// the fee-band tolerance around the gift amount. On success EVERY member gets
// groupReconciledGiftId = the gift; exactly one deterministic "representative"
// also gets matchedGiftId = the gift (satisfying the one-staged↔one-gift
// partial-unique index and making the gift show linked). Reversible as a whole
// via the group-aware revert. Idempotent: re-running with the same rows already
// grouped is blocked by the not-pending guard.
router.post(
  "/staged-payments/group-reconcile",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = GroupReconcileStagedPaymentsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { giftId } = parsed.data;
    const confirmMultiDate = parsed.data.confirmMultiDate === true;
    const confirmAmountMismatch = parsed.data.confirmAmountMismatch === true;
    // De-dupe and sort for a deterministic representative (smallest id).
    const ids = Array.from(new Set(parsed.data.stagedPaymentIds)).sort();
    if (ids.length < 2) {
      res.status(400).json({
        error: "group_too_small",
        message:
          "Group at least two staged payments to reconcile as a unit.",
      });
      return;
    }

    const gift = await db
      .select(giftHeaderColumns)
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    // The group adopts the gift's donor (Donor XOR). Guard the gift carries a
    // single valid donor, exactly like the single-row reconcile path.
    const giftDonor = donorOf(gift);
    if (!hasExactlyOneDonor(giftDonor)) {
      res.status(400).json({
        error: "link_invalid",
        message: "Cannot reconcile this deposit group to that gift.",
        details: {
          issues: [
            {
              path: ["giftId"],
              message: "The selected gift has no donor to adopt.",
            },
          ],
        },
      });
      return;
    }

    const NOT_FOUND = "__not_found__";
    const NOT_PENDING = "__not_pending__";
    const NOT_GROUPABLE = "__not_groupable__";
    const MULTI_DATE = "__multi_date__";
    const AMOUNT_MISMATCH = "__amount_mismatch__";
    const CONFLICT = "__conflict__";

    const representativeId = ids[0];
    let toleranceDetail: { combinedTotal: number; giftAmount: number } | null =
      null;
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stagedPayments)
          .where(inArray(stagedPayments.id, ids))
          .for("update");
        if (locked.length !== ids.length) throw new Error(NOT_FOUND);

        // Take the gift row lock after the staged rows (staged → gift order,
        // shared by reconcile/split) so the conflict checks below run against
        // committed state: any concurrent split/reconcile that claims this gift
        // must commit and release the lock first, after which our READ COMMITTED
        // re-reads see its write and we reject with a conflict.
        await tx
          .select({ id: giftsAndPayments.id })
          .from(giftsAndPayments)
          .where(eq(giftsAndPayments.id, giftId))
          .for("update");

        for (const row of locked) {
          if (
            row.status !== "pending" ||
            row.matchedGiftId != null ||
            row.createdGiftId != null ||
            row.groupReconciledGiftId != null
          ) {
            throw new Error(NOT_PENDING);
          }
        }

        // Compute ONE coherence key per row, identical to the client's
        // groupKeyOf(): prefer the payer (a single wire, or a series of stock
        // sales, split across several QB records — each often settling as its
        // OWN bank deposit over several days, e.g. Arthur Rock 2018-05-22 →
        // 06-15 = 5 deposits, one gift); fall back to the bank deposit only when
        // no payer was captured. The group is coherent iff every member resolves
        // to the SAME non-null key. Keeping this in lockstep with the client is
        // essential — the client disables selection across differing keys, so a
        // server rule that merely required "shared deposit OR shared payer" would
        // accept groups (e.g. one deposit batching DIFFERENT payers) that the UI
        // can never assemble, and — worse — would let a direct API call collapse
        // two different donors who happen to share a deposit into one gift.
        // A human-stamped source group (every member shares one non-null
        // sourceGroupId) is an explicit "these are one physical gift" assertion,
        // so it bypasses the deposit/payer coherence key that ad hoc selections
        // must satisfy. The multi-date + amount-tolerance confirmations below
        // still apply.
        const sourceGroups = new Set(locked.map((r) => r.sourceGroupId));
        const isSourceGroup = sourceGroups.size === 1 && !sourceGroups.has(null);
        if (!isSourceGroup) {
          const keyOf = (r: (typeof locked)[number]): string | null => {
            const payer = (r.payerName ?? "").trim().toLowerCase();
            if (payer) return `payer:${payer}`;
            if (r.qbDepositId) return `dep:${r.qbDepositId}`;
            return null;
          };
          const groupKeys = new Set(locked.map(keyOf));
          if (groupKeys.size !== 1 || groupKeys.has(null)) {
            throw new Error(NOT_GROUPABLE);
          }
        }

        // Grouping payments that cross a date OR deposit boundary risks
        // collapsing unrelated same-payer gifts (e.g. recurring monthly
        // donations, or two genuinely separate deposits that merely share a
        // payer) into one. Require the operator to have explicitly confirmed
        // (confirmMultiDate) whenever the members don't all share one
        // date_received, or carry more than one distinct (non-null) deposit id.
        // A single shared deposit never needs confirmation. The client surfaces
        // a confirm dialog before sending the flag; this is the server boundary.
        const dateKeys = new Set(locked.map((r) => r.dateReceived));
        const distinctDeposits = new Set(
          locked.map((r) => r.qbDepositId).filter((d) => d != null),
        );
        const needsConfirm = dateKeys.size > 1 || distinctDeposits.size > 1;
        if (needsConfirm && !confirmMultiDate) {
          throw new Error(MULTI_DATE);
        }

        // Combined member total must sit in the fee-band tolerance around the
        // gift: gift may be at most a hair under the sum (rounding) and at most
        // ~10% + $1 over (processor fees withheld before deposit).
        const sum = locked.reduce(
          (acc, r) => acc + Number(r.amount ?? 0),
          0,
        );
        const giftAmt = Number(gift.amount ?? 0);
        // Outside the fee-band the combined total is a deliberate mismatch —
        // typically stock/securities gifts whose sale proceeds differ from the
        // booked value. Keep the tight band as the automatic default, but let
        // the operator explicitly approve the mismatch (confirmAmountMismatch)
        // rather than widening the band for every group.
        if (!(giftAmt >= sum - 0.01 && giftAmt <= sum * 1.1 + 1)) {
          if (!confirmAmountMismatch) {
            toleranceDetail = { combinedTotal: sum, giftAmount: giftAmt };
            throw new Error(AMOUNT_MISMATCH);
          }
        }

        // Gift must not already be QB-linked to a staged payment OUTSIDE this
        // group. The ledger unifies direct + split + group-reconciled links, so
        // one existence check (excluding this group's payments) replaces the
        // legacy direct + split guards.
        const conflict = await tx
          .select({ paymentId: paymentApplications.paymentId })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.giftId, giftId),
              eq(paymentApplications.evidenceSource, "quickbooks"),
              notInArray(paymentApplications.paymentId, ids),
            ),
          )
          .then((r) => r[0]);
        if (conflict) throw new Error(CONFLICT);

        const stamp = {
          ...giftDonor,
          // Permanent EVIDENCE tied to the gift (never archived, never a second
          // gift): `reconciled`, not `approved`.
          status: "reconciled" as const,
          createdGiftId: null,
          autoApplied: false,
          matchStatus: "matched" as const,
          matchMethod: "manual" as const,
          matchConfirmedByUserId: user.id,
          matchConfirmedAt: new Date(),
          approvedByUserId: user.id,
          approvedAt: new Date(),
          groupReconciledGiftId: giftId,
          updatedAt: new Date(),
        };

        try {
          // Representative carries matchedGiftId (gift shows linked); the rest
          // reconcile via groupReconciledGiftId alone.
          await tx
            .update(stagedPayments)
            .set({ ...stamp, matchedGiftId: giftId })
            .where(eq(stagedPayments.id, representativeId));
          const memberIds = ids.filter((mid) => mid !== representativeId);
          await tx
            .update(stagedPayments)
            .set({ ...stamp, matchedGiftId: null })
            .where(inArray(stagedPayments.id, memberIds));
        } catch (e) {
          if (
            typeof e === "object" &&
            e !== null &&
            "code" in e &&
            (e as { code?: string }).code === "23505"
          ) {
            throw new Error(CONFLICT);
          }
          throw e;
        }

        // The group's combined QB net total is the gift's final amount, sourced
        // from the representative member's evidence (pointer = representativeId).
        // Skipped as a no-op if the gift is already Stripe-sourced (GROSS wins).
        // A multi-allocation gift whose splits no longer sum is flagged for human
        // re-apportionment rather than silently rescaled.
        const groupStamp = await stampGiftFinalAmount(tx, giftId, {
          source: "quickbooks",
          qbStagedPaymentId: representativeId,
          amount: sum.toFixed(2),
        });
        if (!groupStamp.skipped) {
          await adjustSingleAllocationOrFlag(
            tx,
            giftId,
            groupStamp.oldAmount,
            groupStamp.newAmount,
            "quickbooks",
          );
        }

        // Dual-write (Phase 2): one QB cash-application ledger row PER member
        // payment → the group's gift (each payment fully applies to it; the
        // per-member amounts SUM to the group total).
        for (const member of locked) {
          if (!(member.amount && Number(member.amount) > 0)) continue;
          await applyPaymentApplication(tx, {
            paymentId: member.id,
            giftId,
            amountApplied: member.amount,
            evidenceSource: "quickbooks",
            matchMethod: "human",
            confirmedByUserId: user.id,
            confirmedAt: new Date(),
            createdTheGift: false,
          });
        }
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_FOUND) {
        return notFound(res, "staged payment");
      }
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message:
            "One or more of these staged payments has already been resolved. Refresh and try again.",
        });
        return;
      }
      if (e instanceof Error && e.message === NOT_GROUPABLE) {
        res.status(400).json({
          error: "not_groupable",
          message:
            "These payments must share the same bank deposit, or the same payer, to be grouped.",
        });
        return;
      }
      if (e instanceof Error && e.message === MULTI_DATE) {
        res.status(400).json({
          error: "multi_date_confirmation_required",
          message:
            "These payments are on different dates or bank deposits. Confirm you want to group them into a single gift.",
        });
        return;
      }
      if (e instanceof Error && e.message === AMOUNT_MISMATCH) {
        res.status(400).json({
          error: "amount_mismatch_confirmation_required",
          message:
            "The combined deposit total doesn't match the selected gift within the fee tolerance. Confirm you want to group them anyway.",
          details: toleranceDetail,
        });
        return;
      }
      if (e instanceof Error && e.message === CONFLICT) {
        res.status(409).json({
          error: "link_conflict",
          message:
            "That gift was just linked to another payment. Refresh and try again.",
        });
        return;
      }
      throw e;
    }

    // The grouped gift now carries QB linkage — persist its tie status.
    await applyGiftQbTieMany(giftId);

    res.json({
      gift,
      stagedPaymentIds: ids,
      representativeStagedPaymentId: representativeId,
    });
  }),
);

// ─── POST /staged-payments/:id/split ───────────────────────────────────────
// Split ONE staged payment across TWO OR MORE existing gifts (the case where a
// single incoming-money record — e.g. a Stripe payout that nets fees into a
// lump sum — covers several different donors' gifts). Each portion links to an
// existing gift for that gift's own gross amount; no new gift is minted and
// QuickBooks is never written back. The staged row is marked approved (human
// confirmed) and its own donor / single-gift link columns are cleared — its
// resolution lives entirely in staged_payment_splits. Guards: row pending; at
// least two distinct gifts; each gift exists, carries a single valid donor, and
// is not already linked anywhere (matched / created / group / split); combined
// gross within the fee-band around the staged net amount. Reversible as a whole
// (delete the split links) via the split-aware revert above.
router.post(
  "/staged-payments/:id/split",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = SplitStagedPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    // De-dupe the existing-gift ids. A split needs at least two TOTAL links —
    // existing gifts plus an optional remainder gift minted for the leftover.
    const giftIds = Array.from(new Set(parsed.data.giftIds));
    const remainder = parsed.data.remainderGift ?? null;
    const totalLinks = giftIds.length + (remainder ? 1 : 0);
    if (totalLinks < 2) {
      res.status(400).json({
        error: "split_too_small",
        message:
          "Split across at least two links (existing gifts and/or a remainder gift).",
      });
      return;
    }

    // The remainder routes the leftover to a brand-new gift: positive amount and
    // exactly one donor (Donor XOR) — validated up front for a clean 400.
    let remainderAmount = 0;
    if (remainder) {
      remainderAmount = Number(remainder.amount ?? 0);
      if (!(remainderAmount > 0)) {
        res.status(400).json({
          error: "validation_error",
          message: "The remainder gift amount must be a positive number.",
          details: { issues: [{ path: ["remainderGift", "amount"] }] },
        });
        return;
      }
      const donorIssues = validateGiftInvariants({
        organizationId: remainder.organizationId ?? null,
        individualGiverPersonId: remainder.individualGiverPersonId ?? null,
        householdId: remainder.householdId ?? null,
      });
      if (donorIssues.length) {
        res.status(400).json({
          error: "validation_error",
          message: "The remainder gift needs exactly one donor (Donor XOR).",
          details: { issues: donorIssues },
        });
        return;
      }
    }

    // A grouped row is reconciled only as part of its whole group (the tx below
    // re-checks pending under the row lock; this is the cheap up-front guard).
    const grouped = await db
      .select({ sourceGroupId: stagedPayments.sourceGroupId })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (grouped && grouped.sourceGroupId != null) {
      res.status(409).json({
        error: "source_group_member",
        message:
          "This payment is part of a group. Reconcile the whole group from its card.",
      });
      return;
    }

    const NOT_FOUND = "__not_found__";
    const NOT_PENDING = "__not_pending__";
    const GIFT_NOT_FOUND = "__gift_not_found__";
    const LINK_INVALID = "__link_invalid__";
    const CONFLICT = "__conflict__";
    const TOLERANCE = "__tolerance__";

    let toleranceDetail: { combinedTotal: number; stagedAmount: number } | null =
      null;
    let splitTotal = 0;
    let createdGiftId: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stagedPayments)
          .where(eq(stagedPayments.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked) throw new Error(NOT_FOUND);
        if (locked.status !== "pending") throw new Error(NOT_PENDING);

        // Load every target gift. Lock them so a concurrent reconcile/group/
        // split can't grab one out from under us between the checks and inserts.
        const gifts = await tx
          .select()
          .from(giftsAndPayments)
          .where(inArray(giftsAndPayments.id, giftIds))
          .for("update");
        if (gifts.length !== giftIds.length) throw new Error(GIFT_NOT_FOUND);

        // Each gift must carry a single valid donor (same guard the single-row
        // and group reconcile paths use) — these are real donor gifts.
        for (const gift of gifts) {
          if (!hasExactlyOneDonor(donorOf(gift))) {
            throw new Error(LINK_INVALID);
          }
        }

        // No target gift may already be QB-linked to any staged payment. The
        // ledger unifies direct + split + group-reconciled links, so one
        // existence check replaces the legacy direct + split guards. (The row
        // being split, `id`, has no ledger rows for these gifts yet — it is
        // about to get them — so no exclusion is needed.)
        const linkedElsewhere = await tx
          .select({ giftId: paymentApplications.giftId })
          .from(paymentApplications)
          .where(
            and(
              inArray(paymentApplications.giftId, giftIds),
              eq(paymentApplications.evidenceSource, "quickbooks"),
            ),
          )
          .then((r) => r[0]);
        if (linkedElsewhere) throw new Error(CONFLICT);

        // Tolerance band around the staged NET amount. The gifts' summed GROSS
        // total may run up to ~10% + $1 OVER (processor fees withheld before the
        // lump-sum deposit) AND up to ~10% + $1 UNDER (rounding / small
        // overpayments — e.g. a payout a little above the booked gifts). This is
        // symmetric — deliberately looser on the low side than group-reconcile —
        // so a payment slightly larger than the combined gifts still reconciles
        // instead of being blocked.
        const sumGifts = gifts.reduce(
          (acc, g) => acc + Number(g.amount ?? 0),
          0,
        );
        // Combined GROSS = existing gifts + the optional remainder gift.
        const combinedTotal = sumGifts + remainderAmount;
        const staged = Number(locked.amount ?? 0);
        if (
          !(combinedTotal >= staged * 0.9 - 1 && combinedTotal <= staged * 1.1 + 1)
        ) {
          toleranceDetail = { combinedTotal, stagedAmount: staged };
          throw new Error(TOLERANCE);
        }
        splitTotal = combinedTotal;

        // Mint the remainder gift HEADER (no allocations — same as every other
        // QuickBooks mint; a fundraiser allocates afterward). Anchored to this
        // staged payment so its QB tie derives `tied`. Donor XOR was validated
        // up front.
        if (remainder) {
          createdGiftId = newId();
          await tx.insert(giftsAndPayments).values({
            ...buildGiftValuesFromStaged(
              createdGiftId,
              {
                qbEntityType: locked.qbEntityType,
                qbEntityId: locked.qbEntityId,
                amount: remainder.amount,
                dateReceived: locked.dateReceived,
                payerName: locked.payerName,
                rawReference: locked.rawReference,
                organizationId: remainder.organizationId ?? null,
                individualGiverPersonId:
                  remainder.individualGiverPersonId ?? null,
                householdId: remainder.householdId ?? null,
                matchedPaymentIntermediaryId:
                  locked.matchedPaymentIntermediaryId,
              },
              user.id,
            ),
            amount: remainder.amount,
            finalAmountSource: "quickbooks" as const,
            finalAmountQbStagedPaymentId: id,
            finalAmountStripeChargeId: null,
            originalHumanCrmAmount: null,
          });
        }

        // Insert one split link per gift (sub_amount = that gift's own gross),
        // plus one for the remainder gift (sub_amount = the remainder amount).
        // The unique index on gift_id catches a write-skew race (caught below as
        // a 409 conflict).
        const splitRows = gifts.map((g) => ({
          id: newId(),
          stagedPaymentId: id,
          giftId: g.id,
          subAmount: g.amount ?? "0",
          createdByUserId: user.id,
        }));
        if (createdGiftId) {
          splitRows.push({
            id: newId(),
            stagedPaymentId: id,
            giftId: createdGiftId,
            subAmount: remainder!.amount,
            createdByUserId: user.id,
          });
        }
        try {
          await tx.insert(stagedPaymentSplits).values(splitRows);
        } catch (e) {
          if (
            typeof e === "object" &&
            e !== null &&
            "code" in e &&
            (e as { code?: string }).code === "23505"
          ) {
            throw new Error(CONFLICT);
          }
          throw e;
        }

        // Dual-write (Phase 2): one QB cash-application ledger row per split
        // target gift (amount = that gift's gross sub-amount). The summed GROSS
        // sub-amounts can run slightly above the NET deposit, so pass a fee-band
        // tolerance matching the route's band (staged*1.1+1) so the book-once
        // guard accepts the full set.
        const splitLedgerTolerance = Number(locked.amount ?? 0) * 0.1 + 1;
        for (const g of gifts) {
          if (!(g.amount && Number(g.amount) > 0)) continue;
          await applyPaymentApplication(tx, {
            paymentId: id,
            giftId: g.id,
            amountApplied: g.amount,
            evidenceSource: "quickbooks",
            matchMethod: "human",
            confirmedByUserId: user.id,
            confirmedAt: new Date(),
            createdTheGift: false,
            tolerance: splitLedgerTolerance,
          });
        }
        if (createdGiftId) {
          await applyPaymentApplication(tx, {
            paymentId: id,
            giftId: createdGiftId,
            amountApplied: remainder!.amount,
            evidenceSource: "quickbooks",
            matchMethod: "human",
            confirmedByUserId: user.id,
            confirmedAt: new Date(),
            createdTheGift: true,
            tolerance: splitLedgerTolerance,
          });
        }

        // Mark the staged row resolved. Its own donor columns are NOT
        // authoritative for a split (the money spans several donors), so clear
        // them along with every single-gift link column.
        await tx
          .update(stagedPayments)
          .set({
            organizationId: null,
            individualGiverPersonId: null,
            householdId: null,
            matchedGiftId: null,
            createdGiftId: null,
            groupReconciledGiftId: null,
            status: "approved",
            autoApplied: false,
            matchStatus: "matched",
            matchMethod: "manual",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(eq(stagedPayments.id, id), eq(stagedPayments.status, "pending")),
          );
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_FOUND) {
        return notFound(res, "staged payment");
      }
      if (e instanceof Error && e.message === GIFT_NOT_FOUND) {
        return notFound(res, "gift");
      }
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message: "This staged payment has already been resolved.",
        });
        return;
      }
      if (e instanceof Error && e.message === LINK_INVALID) {
        res.status(400).json({
          error: "link_invalid",
          message: "Cannot split this payment across that gift.",
          details: {
            issues: [
              {
                path: ["giftIds"],
                message: "One of the selected gifts has no donor.",
              },
            ],
          },
        });
        return;
      }
      if (e instanceof Error && e.message === CONFLICT) {
        res.status(409).json({
          error: "link_conflict",
          message:
            "One of those gifts is already linked to a payment. Refresh and try again.",
        });
        return;
      }
      if (e instanceof Error && e.message === TOLERANCE) {
        res.status(400).json({
          error: "amount_mismatch",
          message:
            "The gifts' combined total doesn't match the payment within the fee tolerance.",
          details: toleranceDetail,
        });
        return;
      }
      throw e;
    }

    // The split now ties each gift to part of this QB record — persist ties for
    // every linked gift, including the freshly minted remainder gift.
    const allGiftIds = createdGiftId ? [...giftIds, createdGiftId] : giftIds;
    await applyGiftQbTieMany(...allGiftIds);

    res.json({
      stagedPaymentId: id,
      giftIds: allGiftIds,
      splitTotal: splitTotal.toFixed(2),
      createdGiftId,
    });
  }),
);

// ─── POST /staged-payments/confirm-matches ─────────────────────────────────
// Bulk equivalent of confirm-match: stamp many auto-applied/suggested matches
// as human-confirmed in one call (used to clear the Auto-matched queue). Only
// rows in a confirmable state (a pending row with a donor, OR an auto-applied
// approved row) are updated; any other id is silently skipped so a partially
// stale selection still succeeds. The single WHERE mirrors confirm-match's
// eligibility predicate, so direct API callers can't bypass it.
router.post(
  "/staged-payments/confirm-matches",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = ConfirmStagedPaymentMatchesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    // `requested` reflects how many ids the caller submitted; dedupe only the
    // values fed to the UPDATE so a repeated id can't be confirmed twice.
    const requested = parsed.data.ids.length;
    const ids = Array.from(new Set(parsed.data.ids));
    const now = new Date();
    const confirmedIds = await db.transaction(async (tx) => {
      const rows = await tx
        .update(stagedPayments)
        .set({
          matchStatus: "matched",
          matchConfirmedByUserId: user.id,
          matchConfirmedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(stagedPayments.id, ids),
            sql`num_nonnulls(${stagedPayments.organizationId}, ${stagedPayments.individualGiverPersonId}, ${stagedPayments.householdId}) >= 1`,
            sql`(${stagedPayments.status} = 'pending'
                 OR (${stagedPayments.status} = 'approved' AND ${stagedPayments.autoApplied} = true))`,
          ),
        )
        .returning({ id: stagedPayments.id });
      // Promote any auto-applied (system) ledger rows for these payments to
      // system_confirmed (who/when stamped, no amount/link change). Pending
      // donor-match rows that never minted a gift have no system rows ⇒ no-op.
      for (const r of rows) {
        await confirmPaymentApplicationsForPayment(tx, r.id, user.id, now);
      }
      return rows.map((r) => r.id);
    });
    res.json({ confirmedIds, requested });
  }),
);

// ─── POST /staged-payments/:id/confirm-match ───────────────────────────────
// Confirm a system-suggested donor match (auto-matched → human approved)
// without changing the donor or minting a gift. For auto-applied rows this is
// what graduates them from "Auto-matched" to "Done". Works on a pending row
// with a donor OR an auto-applied approved row.
router.post(
  "/staged-payments/:id/confirm-match",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const now = new Date();
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(stagedPayments)
        .set({
          matchStatus: "matched",
          matchConfirmedByUserId: user.id,
          matchConfirmedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(stagedPayments.id, id),
            sql`num_nonnulls(${stagedPayments.organizationId}, ${stagedPayments.individualGiverPersonId}, ${stagedPayments.householdId}) >= 1`,
            sql`(${stagedPayments.status} = 'pending'
                 OR (${stagedPayments.status} = 'approved' AND ${stagedPayments.autoApplied} = true))`,
          ),
        )
        .returning(stagedReturnColumns);
      // Promote auto-applied (system) ledger rows for this payment to
      // system_confirmed; no-op when the row wasn't confirmable or had none.
      if (updated) {
        await confirmPaymentApplicationsForPayment(tx, id, user.id, now);
      }
      return updated;
    });
    if (!row) {
      const exists = await db
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(eq(stagedPayments.id, id))
        .then((r) => r[0]);
      if (!exists) return notFound(res, "staged payment");
      res.status(409).json({
        error: "conflict",
        message:
          "This staged payment can't be confirmed (no donor, or not in a confirmable state). Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/unmatch ─────────────────────────────────────
// Clear the donor match and reset to unmatched. Only a pending row.
router.post(
  "/staged-payments/:id/unmatch",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const existing = await db
      .select({ status: stagedPayments.status })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "Only pending staged payments can be unmatched.",
      });
      return;
    }
    const [row] = await db
      .update(stagedPayments)
      .set({
        organizationId: null,
        individualGiverPersonId: null,
        householdId: null,
        matchedPaymentIntermediaryId: null,
        matchStatus: "unmatched",
        matchScore: null,
        matchMethod: null,
        matchConfirmedByUserId: null,
        matchConfirmedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(stagedPayments.id, id), eq(stagedPayments.status, "pending")),
      )
      .returning(stagedReturnColumns);
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment is no longer pending. Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

export default router;
