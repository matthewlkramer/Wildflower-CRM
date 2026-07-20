import {
  db,
  giftsAndPayments,
  stripeStagedCharges,
  paymentApplications,
} from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import { applyDerivedOppFieldsMany } from "./pledgeStage";

/* ────────────────────────────────────────────────────────────────────────
 * Stripe refund / chargeback propagation (INV-13).
 *
 * When a refund or dispute lands on a Stripe charge whose money is ALREADY
 * booked into a CRM gift, we surface it — but never silently. The sync worker
 * only ever RAISES a `proposed` (see `stripeSync.ts`); a human then confirms
 * or dismisses it here.
 *
 * Confirm is TRANSACTION-LEVEL (workbench business rules §2.1 "Refunded
 * transactions"): the refund belongs to the individual transaction. The CRM
 * gift and its allocations are NEVER archived or resized here.
 *
 *   full refund   → the charge stops counting as live payment evidence: its
 *                   counted cash-application row is demoted to `corroborating`
 *                   (audit trail retained, out of the money-trail SUM).
 *   chargeback    → same as a full refund.
 *   partial refund→ the refunded portion is recorded against the transaction
 *                   only: the counted row's amount_applied is capped at
 *                   gross − amount_refunded (demoted entirely when nothing
 *                   remains). The gift amount is untouched.
 *
 * On confirm, any linked pledge re-derives its paid-amount / status against
 * the (unchanged) gift, and the gift's QB-tie status — live-derived from the
 * counted ledger — reflects the reduced coverage automatically. The evidence
 * row (stripe_staged_charges) is retained, marked applied. Whether the money
 * will be replaced or the opportunity is lost/dormant stays a separate,
 * explicit human decision. Idempotency lives in `deriveRefundProposal`: a
 * re-sync of the same refund state never re-raises a handled proposal.
 * ──────────────────────────────────────────────────────────────────────── */

export type StripeRefundKind = "full_refund" | "partial_refund" | "chargeback";

export interface RefundFacts {
  refunded: boolean;
  disputed: boolean;
  amountRefunded: string | null;
  grossAmount: string | null;
}

export interface RefundProposalState {
  refundPropagationStatus: "none" | "proposed" | "applied" | "dismissed";
  refundPropagationKind: StripeRefundKind | null;
  refundProposedAmount: string | null;
}

export interface RefundProposal {
  kind: StripeRefundKind;
  // The absolute amount being reversed (2dp string): gross for a full refund /
  // chargeback, the cumulative Stripe amount_refunded for a partial refund.
  reversedAmount: string;
}

// Cent-level tolerance for money comparisons (amounts are 2dp strings).
const TOLERANCE = 0.005;

function num(v: string | null | undefined): number {
  const n = v != null ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Classify a charge's refund/dispute facts into a reversal kind, or null when
 * there is nothing to reverse. A dispute always reverses the whole charge
 * (chargeback) regardless of any refund amount.
 */
export function classifyRefund(facts: RefundFacts): RefundProposal | null {
  const gross = num(facts.grossAmount);
  const refunded = num(facts.amountRefunded);

  if (facts.disputed) {
    return { kind: "chargeback", reversedAmount: gross.toFixed(2) };
  }
  if (refunded > TOLERANCE) {
    if (gross > 0 && refunded >= gross - TOLERANCE) {
      return { kind: "full_refund", reversedAmount: gross.toFixed(2) };
    }
    return { kind: "partial_refund", reversedAmount: refunded.toFixed(2) };
  }
  // `refunded` flag set but no amount (rare) — treat as a full refund.
  if (facts.refunded && gross > 0) {
    return { kind: "full_refund", reversedAmount: gross.toFixed(2) };
  }
  return null;
}

/**
 * True when the charge's live facts say the money is FULLY refunded (a plain
 * refund — a dispute classifies as chargeback and is deliberately NOT this).
 * Used by the never-booked auto-exclusion (`refunded_charge`): a fully-refunded
 * charge with no gift link is not workable money. Charges WITH a gift link
 * never use this — they take the propose-then-confirm propagation path above.
 */
export function isFullyRefunded(facts: RefundFacts): boolean {
  return classifyRefund(facts)?.kind === "full_refund";
}

function signature(
  kind: StripeRefundKind | "" | null,
  reversedAmount: string | null,
): string {
  return `${kind ?? ""}|${reversedAmount ?? ""}`;
}

/**
 * Decide whether to raise (or re-raise) a refund proposal given the charge's
 * current facts and existing propagation state. Returns the proposal to raise,
 * or null to leave the row as-is.
 *
 * Idempotent: once a proposal has been proposed/applied/dismissed for an exact
 * refund signature (kind + reversed amount), it is never re-raised. An
 * ESCALATION (e.g. partial $10 → partial $25 → full) changes the signature and
 * re-raises a fresh proposal so the new money can be reversed too — even past a
 * prior `applied` or `dismissed`.
 */
export function deriveRefundProposal(
  facts: RefundFacts,
  state: RefundProposalState,
  hasLinkedGift: boolean,
): RefundProposal | null {
  const c = classifyRefund(facts);
  if (!c) return null; // no refund / dispute
  if (!hasLinkedGift) return null; // no booked gift to propagate to

  if (state.refundPropagationStatus !== "none") {
    const currentSig = signature(
      state.refundPropagationKind,
      state.refundProposedAmount,
    );
    if (currentSig === signature(c.kind, c.reversedAmount)) return null;
  }
  return c;
}

function appendAudit(existing: string | null, line: string): string {
  const stamp = `[${new Date().toISOString()}] ${line}`;
  return existing && existing.trim() ? `${existing}\n${stamp}` : stamp;
}

export type RefundConfirmCode =
  | "ok"
  | "not_found"
  | "not_proposed"
  | "no_linked_gift"
  | "gift_missing";

export interface RefundConfirmResult {
  code: RefundConfirmCode;
  chargeId: string;
  giftId?: string;
  pledgeId?: string | null;
  kind?: StripeRefundKind;
  /** True when the charge's counted application was demoted out of coverage. */
  retiredFromCoverage?: boolean;
  /** For a partial refund, the counted amount still applied (null if demoted). */
  remainingApplied?: string | null;
}

/**
 * Human-confirm a proposed refund/chargeback at the TRANSACTION level: retire
 * (full refund / chargeback) or reduce (partial refund) the charge's counted
 * cash-application row so the refunded money leaves live payment coverage,
 * then mark the staged charge `applied`. The linked gift and its allocations
 * are never archived or resized. Re-runs the linked pledge's derivation after
 * commit; the gift's QB-tie status is live-derived from the counted ledger, so
 * it reflects the reduced coverage without a recompute call. Guarded so only a
 * `proposed` row can be confirmed (409 otherwise).
 */
export async function confirmRefundPropagation(
  chargeId: string,
  userId: string,
): Promise<RefundConfirmResult> {
  let result: RefundConfirmResult = { code: "ok", chargeId };

  await db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, chargeId))
      .for("update")
      .then((r) => r[0]);
    if (!locked) {
      result = { code: "not_found", chargeId };
      return;
    }
    if (locked.refundPropagationStatus !== "proposed") {
      result = { code: "not_proposed", chargeId };
      return;
    }

    // Ledger fallback: the gift this charge is counted against (the legacy
    // matched/created gift-pointer columns are retired, never read).
    const countedRow = await tx
      .select({
        id: paymentApplications.id,
        giftId: paymentApplications.giftId,
        amountApplied: paymentApplications.amountApplied,
        note: paymentApplications.note,
      })
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.stripeChargeId, chargeId),
          eq(paymentApplications.evidenceSource, "stripe"),
          eq(paymentApplications.linkRole, "counted"),
        ),
      )
      .for("update")
      .limit(1)
      .then((r) => r[0]);
    const giftId = locked.refundPropagationGiftId ?? countedRow?.giftId ?? null;
    if (!giftId) {
      result = { code: "no_linked_gift", chargeId };
      return;
    }

    // Read-only sanity check + pledge pointer — the gift itself is NEVER
    // archived or resized by a refund confirm (§2.1: the refund belongs to
    // the transaction; whether the money is replaced or the opportunity is
    // lost/dormant is a separate explicit human decision).
    const gift = await tx
      .select({
        id: giftsAndPayments.id,
        opportunityId: giftsAndPayments.opportunityId,
      })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .then((r) => r[0]);
    if (!gift) {
      result = { code: "gift_missing", chargeId };
      return;
    }

    const kind = locked.refundPropagationKind as StripeRefundKind;
    const pledgeId = gift.opportunityId ?? null;
    const now = new Date();
    let retiredFromCoverage = false;
    let remainingApplied: string | null = null;

    // Retire the charge's counted application from live coverage — the same
    // demote convention as chargeTieSupersede: linkRole → 'corroborating'
    // (audit crumb retained, out of every counted SUM). Clear a colliding
    // corroborating row for the (charge, gift) pair first (partial UNIQUE).
    const demoteCounted = async (rowId: string, rowGiftId: string) => {
      await tx
        .delete(paymentApplications)
        .where(
          and(
            eq(paymentApplications.stripeChargeId, chargeId),
            eq(paymentApplications.giftId, rowGiftId),
            eq(paymentApplications.linkRole, "corroborating"),
            ne(paymentApplications.id, rowId),
          ),
        );
      await tx
        .update(paymentApplications)
        .set({
          linkRole: "corroborating",
          note: appendAudit(
            countedRow?.note ?? null,
            `Retired from live coverage by Stripe ${kind === "chargeback" ? "chargeback" : "refund"} confirm (charge ${chargeId}).`,
          ),
          updatedAt: now,
        })
        .where(eq(paymentApplications.id, rowId));
      retiredFromCoverage = true;
    };

    if (countedRow) {
      if (kind === "partial_refund") {
        // Cap the counted application at what actually stayed after the
        // refund (gross − amount_refunded); demote entirely when nothing
        // remains. The gift amount is untouched.
        const remaining = Math.max(
          0,
          num(locked.grossAmount) - num(locked.amountRefunded),
        );
        const applied = num(countedRow.amountApplied);
        if (remaining <= TOLERANCE) {
          await demoteCounted(countedRow.id, countedRow.giftId);
        } else if (applied > remaining + TOLERANCE) {
          remainingApplied = remaining.toFixed(2);
          await tx
            .update(paymentApplications)
            .set({ amountApplied: remainingApplied, updatedAt: now })
            .where(eq(paymentApplications.id, countedRow.id));
        } else {
          remainingApplied = countedRow.amountApplied;
        }
      } else {
        // full_refund or chargeback — the whole transaction stops counting
        // as live payment evidence.
        await demoteCounted(countedRow.id, countedRow.giftId);
      }
    }

    await tx
      .update(stripeStagedCharges)
      .set({
        refundPropagationStatus: "applied",
        refundPropagationGiftId: giftId,
        refundConfirmedByUserId: userId,
        refundConfirmedAt: now,
        updatedAt: now,
      })
      .where(eq(stripeStagedCharges.id, chargeId));

    result = {
      code: "ok",
      chargeId,
      giftId,
      pledgeId,
      kind,
      retiredFromCoverage,
      remainingApplied: kind === "partial_refund" ? remainingApplied : null,
    };
  });

  if (result.code === "ok" && result.giftId) {
    if (result.pledgeId) await applyDerivedOppFieldsMany(result.pledgeId);
  }

  return result;
}

export type RefundDismissCode = "ok" | "not_found" | "not_proposed";

/**
 * Human-dismiss a proposed refund/chargeback: do NOT touch the gift, mark the
 * staged charge `dismissed`. The kind + proposed amount are retained as the
 * idempotency signature so a re-sync of the same refund state won't re-raise it
 * (an escalation to a larger refund still re-raises a fresh proposal).
 */
export async function dismissRefundPropagation(
  chargeId: string,
  userId: string,
): Promise<{ code: RefundDismissCode; chargeId: string }> {
  let code: RefundDismissCode = "ok";

  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ status: stripeStagedCharges.refundPropagationStatus })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, chargeId))
      .for("update")
      .then((r) => r[0]);
    if (!locked) {
      code = "not_found";
      return;
    }
    if (locked.status !== "proposed") {
      code = "not_proposed";
      return;
    }
    await tx
      .update(stripeStagedCharges)
      .set({
        refundPropagationStatus: "dismissed",
        refundConfirmedByUserId: userId,
        refundConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(stripeStagedCharges.id, chargeId));
  });

  return { code, chargeId };
}
