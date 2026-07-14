import { db, giftsAndPayments, stripeStagedCharges } from "@workspace/db";
import { eq } from "drizzle-orm";
import { adjustSingleAllocationOrFlag } from "./giftFinalAmount";
import { applyGiftQbTieMany } from "./giftQbTie";
import { applyDerivedOppFieldsMany } from "./pledgeStage";
import { getStripeChargeGiftRelationship } from "./stripeChargeLedger";

/*
 * Stripe refund / chargeback propagation (INV-13).
 *
 * Refunds are propagated only when the charge has a CONFIRMED counted Stripe
 * payment application. Legacy matched_gift_id / created_gift_id pointers are
 * deliberately ignored: payment_applications is the authoritative money tie.
 */

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
  reversedAmount: string;
}

const TOLERANCE = 0.005;

function num(value: string | null | undefined): number {
  const parsed = value != null ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

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
  if (facts.refunded && gross > 0) {
    return { kind: "full_refund", reversedAmount: gross.toFixed(2) };
  }
  return null;
}

export function isFullyRefunded(facts: RefundFacts): boolean {
  return classifyRefund(facts)?.kind === "full_refund";
}

function signature(
  kind: StripeRefundKind | "" | null,
  reversedAmount: string | null,
): string {
  return `${kind ?? ""}|${reversedAmount ?? ""}`;
}

export function deriveRefundProposal(
  facts: RefundFacts,
  state: RefundProposalState,
  hasLinkedGift: boolean,
): RefundProposal | null {
  const proposal = classifyRefund(facts);
  if (!proposal || !hasLinkedGift) return null;

  if (state.refundPropagationStatus !== "none") {
    const current = signature(
      state.refundPropagationKind,
      state.refundProposedAmount,
    );
    if (current === signature(proposal.kind, proposal.reversedAmount)) {
      return null;
    }
  }
  return proposal;
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
  newGiftAmount?: string | null;
  archivedGift?: boolean;
}

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
      .then((rows) => rows[0]);

    if (!locked) {
      result = { code: "not_found", chargeId };
      return;
    }
    if (locked.refundPropagationStatus !== "proposed") {
      result = { code: "not_proposed", chargeId };
      return;
    }

    const relationship = await getStripeChargeGiftRelationship(tx, chargeId, {
      includeProposed: false,
    });
    const giftId = relationship?.giftId ?? null;
    if (!giftId) {
      result = { code: "no_linked_gift", chargeId };
      return;
    }

    const gift = await tx
      .select({
        id: giftsAndPayments.id,
        amount: giftsAndPayments.amount,
        archivedAt: giftsAndPayments.archivedAt,
        opportunityId: giftsAndPayments.opportunityId,
        details: giftsAndPayments.details,
      })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .for("update")
      .then((rows) => rows[0]);

    if (!gift) {
      result = { code: "gift_missing", chargeId };
      return;
    }

    const kind = locked.refundPropagationKind as StripeRefundKind;
    const pledgeId = gift.opportunityId ?? null;
    const now = new Date();
    let newGiftAmount: string | null = gift.amount;
    let archivedGift = false;

    if (kind === "partial_refund") {
      const reduced = Math.max(
        0,
        num(locked.grossAmount) - num(locked.amountRefunded),
      );
      newGiftAmount = reduced.toFixed(2);
      const oldAmount = gift.amount;

      await tx
        .update(giftsAndPayments)
        .set({
          amount: newGiftAmount,
          details: appendAudit(
            gift.details,
            `Stripe partial refund applied: gift reduced from ${oldAmount ?? "—"} to ${newGiftAmount} (charge ${locked.id}).`,
          ),
          updatedAt: now,
        })
        .where(eq(giftsAndPayments.id, giftId));

      await adjustSingleAllocationOrFlag(
        tx,
        giftId,
        oldAmount,
        newGiftAmount,
        "stripe",
      );
    } else {
      archivedGift = true;
      if (!gift.archivedAt) {
        await tx
          .update(giftsAndPayments)
          .set({
            archivedAt: now,
            details: appendAudit(
              gift.details,
              `Stripe ${kind === "chargeback" ? "chargeback" : "full refund"} reversed this gift (charge ${locked.id}).`,
            ),
            updatedAt: now,
          })
          .where(eq(giftsAndPayments.id, giftId));
      }
    }

    await tx
      .update(stripeStagedCharges)
      .set({
        refundPropagationStatus: "applied",
        // Keep the immutable audit snapshot, but derive the relationship from the
        // ledger on every future operation.
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
      newGiftAmount: kind === "partial_refund" ? newGiftAmount : null,
      archivedGift,
    };
  });

  if (result.code === "ok" && result.giftId) {
    await applyGiftQbTieMany(result.giftId);
    if (result.pledgeId) await applyDerivedOppFieldsMany(result.pledgeId);
  }

  return result;
}

export type RefundDismissCode = "ok" | "not_found" | "not_proposed";

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
      .then((rows) => rows[0]);

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
