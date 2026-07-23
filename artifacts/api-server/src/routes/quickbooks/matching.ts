import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  giftAllocations,
  paymentApplications,
} from "@workspace/db/schema";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { asyncHandler, notFound, paramId } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import {
  ReconcileStagedPaymentBody,
  MultiMatchStagedPaymentsBody,
  ConfirmStagedPaymentMatchesBody,
} from "@workspace/api-zod";
import { donorOf, hasExactlyOneDonor } from "../../lib/quickbooksLink";
import {
  AnchorAlreadyCountedError,
  applyPaymentApplication,
  confirmPaymentApplicationsForPayment,
  qbLedgerExistsForGiftExcludingPayment,
} from "../../lib/paymentApplications";
import { stagedReturnColumns, stagedRowWithStatus } from "./shared";
import {
  stagedStatusSql,
  stagedStatusWhere,
  stagedStatusIn,
} from "../../lib/derivedStatus";
import { giftHeaderColumns } from "../giftsAndPayments";
import { amountWithinFeeBand } from "../../lib/reconciliationGate";
import {
  reconAudit,
  fmtMoney,
  payerLabel,
} from "../../lib/reconciliationAudit";

const router: IRouter = Router();

// ─── POST /staged-payments/:id/reconcile ───────────────────────────────────
// Tie a staged payment to an EXISTING gift (no new gift minted). Books a
// counted QB cash-application ledger row → the chosen gift, autoApplied=false
// (derives match_confirmed). An
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
      .select({
        ...getTableColumns(stagedPayments),
        status: stagedStatusSql.as("status"),
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
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
    // pre-check. The ledger NOT EXISTS guard handles the common case, and the
    // cross-path invariant (a gift is claimed in exactly one place) is enforced
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
            // gift, never archived and never a second gift. The counted ledger
            // row (booked below) + autoApplied=false derive the terminal
            // match_confirmed status; the legacy gift-link columns are
            // @deprecated and no longer written.
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
              stagedStatusWhere.pending,
              // Gift must not already be QB-linked to another staged payment.
              // The ledger unifies direct + split + group-reconciled links, so
              // one existence check replaces the legacy direct + split guards.
              sql`NOT ${qbLedgerExistsForGiftExcludingPayment(sql`${giftId}`, sql`${id}`)}`,
            ),
          )
          .returning({ id: stagedPayments.id });

        // Tie succeeded. The gift's `amount` is never overwritten by
        // reconciliation (Task #757) — settled money is derived from the
        // counted ledger row booked below.
        if (updated.length > 0) {
          // Book the QB cash-application ledger row — the SOLE resolution record.
          // This staged payment fully applies to the matched gift (1:1 link).
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
      // Counted-uniqueness: this payment already carries a counted ledger row
      // for a different gift (e.g. a lingering auto-match). Revert it first.
      if (e instanceof AnchorAlreadyCountedError) {
        res.status(409).json({
          error: "payment_already_applied",
          message:
            "This payment is already applied to another gift (an existing match). Revert that reconciliation first, then re-target it here.",
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

    // Direct match to an existing gift — the staged revert safely undoes it.
    await reconAudit(req, {
      action: "update",
      entityType: "staged_payment",
      entityId: id,
      summary: `Matched the QuickBooks payment from ${payerLabel(existing.payerName)} (${fmtMoney(existing.amount)}) to gift "${gift.name ?? giftId}"`,
      undo: { kind: "revert_staged_payment", targetId: id },
      extra: { giftId },
    });
    res.json({ gift, stagedPaymentId: id });
  }),
);

// ─── POST /staged-payments/multi-match ─────────────────────────────────────
// Match several staged payments — selected together in the workbench — to ONE
// existing CRM gift (which typically carries multiple allocations). The ADR
// linear-money-model (docs/adr-linear-money-model.md) replacement for
// group-then-match: NO unit group is created; the counted ledger rows alone
// express the combined outcome (one per member, booked in one transaction).
// Members must form one coherent selection: either they share ONE underlying
// bank Deposit (qbDepositId), or they share the same payer name (a single
// wire, or a series of stock sales, split across several QB records — each
// often settling as its OWN bank deposit over several days). No new gift is
// minted and QuickBooks is never written back. Guards: at least two rows; every row pending and not already
// resolved; when the rows span more than one date_received OR more than one
// distinct deposit the caller must pass confirmMultiDate; the gift exists
// with a single valid donor and is not already linked to any other staged
// row; the members' combined total sits in the fee-band tolerance around the
// gift amount. On success EVERY member books a counted QB cash-application
// ledger row → the gift. Each member reverts individually via the normal
// revert path (no group semantics). Idempotent: re-running with the same rows
// already matched is blocked by the not-pending guard.
router.post(
  "/staged-payments/multi-match",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = MultiMatchStagedPaymentsBody.safeParse(req.body);
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
    // De-dupe and sort for deterministic processing order.
    const ids = Array.from(new Set(parsed.data.stagedPaymentIds)).sort();
    if (ids.length < 2) {
      res.status(400).json({
        error: "selection_too_small",
        message:
          "Select at least two staged payments to match as one gift.",
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
    const ZERO_AMOUNT = "__zero_amount__";
    const CONFLICT = "__conflict__";

    let toleranceDetail: { combinedTotal: number; giftAmount: number } | null =
      null;
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select({
            ...getTableColumns(stagedPayments),
            status: stagedStatusSql.as("status"),
          })
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
          // "Open for reconciliation" = derived status `pending`. The derived
          // model already folds the legacy edge cases in: a row whose gift was
          // later deleted (gift-link FKs are ON DELETE SET NULL) loses its
          // evidence and derives back to `pending`, so it is still real work
          // and groups; rows with any gift link, settlement/split evidence
          // (match_proposed / match_confirmed) or an exclusion are not open.
          if (row.status !== "pending") {
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
        // (Legacy unit_groups membership is no longer read — the retired
        // tables are inert until dropped, docs/adr-linear-money-model.md.)
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

        // Every member must carry positive money: a zero/negative-amount row
        // can't book a counted ledger row, so it would end up stamped
        // "matched" with NO ledger record — a phantom match the revert path
        // can't see. Reject the selection instead of silently skipping it.
        if (locked.some((r) => !(r.amount && Number(r.amount) > 0))) {
          throw new Error(ZERO_AMOUNT);
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
        // booked value. There is no override: the operator must correct the
        // gift's amount to the combined total and reconcile, so the gift and the
        // money it represents stay in agreement.
        if (!amountWithinFeeBand(String(sum), String(giftAmt))) {
          toleranceDetail = { combinedTotal: sum, giftAmount: giftAmt };
          throw new Error(AMOUNT_MISMATCH);
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

        // NO unit group is written (ADR linear-money-model): the counted
        // ledger rows booked below are the sole record of the combined
        // outcome. An existing LEGACY group is left untouched — its
        // membership read above only relaxes the coherence key.

        // Permanent EVIDENCE tied to the gift (never archived, never a second
        // gift): the counted ledger rows booked below derive the terminal
        // match_confirmed; the legacy gift-link columns are @deprecated and no
        // longer written.
        await tx
          .update(stagedPayments)
          .set({
            ...giftDonor,
            autoApplied: false,
            matchStatus: "matched" as const,
            matchMethod: "manual" as const,
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(inArray(stagedPayments.id, ids));

        // The gift's `amount` is never overwritten by reconciliation
        // (Task #757) — the group's settled money is derived from the counted
        // ledger rows booked below.
        // Book one QB cash-application ledger row (the SOLE resolution record) PER member
        // payment → the group's gift (each payment fully applies to it; the
        // per-member amounts SUM to the group total).
        for (const member of locked) {
          // Non-null: the ZERO_AMOUNT guard above rejected any member without
          // a positive amount before we got here.
          await applyPaymentApplication(tx, {
            paymentId: member.id,
            giftId,
            amountApplied: member.amount!,
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
          error: "amount_mismatch",
          message:
            "The combined deposit total doesn't match the selected gift within the fee tolerance. Correct the gift's amount to the combined total, then reconcile.",
          details: toleranceDetail,
        });
        return;
      }
      if (e instanceof Error && e.message === ZERO_AMOUNT) {
        res.status(400).json({
          error: "zero_amount_member",
          message:
            "Every selected payment must carry a positive amount. Remove the zero-amount row from the selection and try again.",
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
      // Counted-uniqueness: a member already carries a counted ledger row for
      // a different gift (e.g. a lingering auto-match). Revert it first.
      if (e instanceof AnchorAlreadyCountedError) {
        res.status(409).json({
          error: "payment_already_applied",
          message:
            "One of these payments is already applied to another gift (an existing match). Revert that reconciliation first, then try again.",
        });
        return;
      }
      throw e;
    }

    res.json({
      gift,
      stagedPaymentIds: ids,
    });
  }),
);

// ─── POST /staged-payments/group-reconcile (RETIRED) ───────────────────────
// Tombstone: group-then-match is replaced by /staged-payments/multi-match
// (docs/adr-linear-money-model.md — group creation is retired; the counted
// ledger rows alone express a combined match).
router.post("/staged-payments/group-reconcile", (_req, res) => {
  res.status(410).json({
    error: "group_creation_retired",
    message:
      "Group-reconcile is retired. Select the rows together and match them with POST /staged-payments/multi-match.",
  });
});

// ─── POST /staged-payments/:id/split (RETIRED) ─────────────────────────────
// Tombstone: gift-side splitting is retired by the linear money model
// (docs/adr-linear-money-model.md rule 5 + §7 step 5). One counted
// payment_applications row per evidence anchor is enforced by a partial
// unique index, so fanning ONE staged payment out across several gifts is no
// longer representable. Divide the evidence row instead with
// POST /reconciliation/staged-payments/:id/split-units, then match each child
// unit to its own gift through the normal flows.
router.post("/staged-payments/:id/split", (_req, res) => {
  res.status(410).json({
    error: "gift_side_split_retired",
    message:
      "Gift-side splitting is retired. Split the payment into child units (Reconciliation → Split into units), then match each unit to its gift.",
  });
});

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
            stagedStatusIn(["pending", "match_proposed"]),
            // Only the still-unconfirmed set: a row whose donor match was
            // already human-stamped is done from this queue's point of view,
            // even if it derives `pending` money-wise (no gift yet).
            isNull(stagedPayments.matchConfirmedAt),
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
            stagedStatusIn(["pending", "match_proposed"]),
            // Mirror confirm-matches: only still-unconfirmed rows.
            isNull(stagedPayments.matchConfirmedAt),
          ),
        )
        .returning(stagedReturnColumns);
      // Promote auto-applied (system) ledger rows for this payment to
      // system_confirmed; no-op when the row wasn't confirmable or had none.
      if (updated) {
        await confirmPaymentApplicationsForPayment(tx, id, user.id, now);
        // Echo status from the ledger: an auto-applied row keeps its counted
        // application (now confirmed); a donor-only row has none.
        const hasApp = await tx
          .select({ id: paymentApplications.id })
          .from(paymentApplications)
          .where(
            and(
              eq(paymentApplications.paymentId, id),
              eq(paymentApplications.linkRole, "counted"),
            ),
          )
          .limit(1)
          .then((r) => r.length > 0);
        return stagedRowWithStatus(updated, hasApp);
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
      .select({ status: stagedStatusSql.as("status") })
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
      .where(and(eq(stagedPayments.id, id), stagedStatusWhere.pending))
      .returning(stagedReturnColumns);
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment is no longer pending. Refresh and retry.",
      });
      return;
    }
    // A pending row has no counted ledger rows by definition.
    res.json(stagedRowWithStatus(row, false));
  }),
);

export default router;
