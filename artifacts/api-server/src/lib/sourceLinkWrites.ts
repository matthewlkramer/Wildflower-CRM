import { sourceLinks, sourceLinkId, type SourceLink } from "@workspace/db/schema";
import { and, eq, sql, type InferInsertModel } from "drizzle-orm";
import type { db } from "@workspace/db";

/**
 * Write helpers for the `source_links` evidence↔evidence claim ledger
 * (docs/adr-source-link-ledger.md). Every pointer write path calls one of
 * these IN THE SAME TRANSACTION as its (transition-window) pointer mirror
 * write, so ledger and pointers can never diverge mid-flight.
 *
 * Deterministic ids (`sourceLinkId`) make every upsert idempotent and make
 * the proposed→confirmed tie transition ONE row changing lifecycle.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

type NewLink = InferInsertModel<typeof sourceLinks>;

function tieRow(chargeId: string, qbId: string): Pick<NewLink, "id" | "linkType" | "stripeChargeId" | "qbStagedPaymentId"> {
  return {
    id: sourceLinkId("charge_qb_tie", chargeId),
    linkType: "charge_qb_tie",
    stripeChargeId: chargeId,
    qbStagedPaymentId: qbId,
  };
}

/** Upsert the PROPOSED tie for a charge (system provenance). Never demotes a
 * confirmed row — the caller guards on the confirmed tie being absent, and
 * the WHERE here re-asserts it. */
export async function upsertProposedChargeTie(
  tx: Tx,
  chargeId: string,
  qbStagedPaymentId: string,
): Promise<void> {
  await tx
    .insert(sourceLinks)
    .values({
      ...tieRow(chargeId, qbStagedPaymentId),
      lifecycle: "proposed",
      provenance: "system",
    })
    .onConflictDoUpdate({
      target: sourceLinks.id,
      set: {
        qbStagedPaymentId,
        lifecycle: "proposed",
        provenance: "system",
        confirmedByUserId: null,
        confirmedAt: null,
        updatedAt: new Date(),
      },
      setWhere: sql`${sourceLinks.lifecycle} = 'proposed'`,
    });
}

/** Delete the PROPOSED tie row for a charge (reject / stale-clear / scope
 * exit). Confirmed rows are never touched. */
export async function clearProposedChargeTie(
  tx: Tx,
  chargeId: string,
): Promise<void> {
  await tx
    .delete(sourceLinks)
    .where(
      and(
        eq(sourceLinks.id, sourceLinkId("charge_qb_tie", chargeId)),
        eq(sourceLinks.lifecycle, "proposed"),
      ),
    );
}

/** Upsert the CONFIRMED tie for a charge (human confirm — promotes an
 * existing proposal row or creates the row outright for manual ties). */
export async function upsertConfirmedChargeTie(
  tx: Tx,
  chargeId: string,
  qbStagedPaymentId: string,
  confirmedByUserId: string,
  confirmedAt: Date = new Date(),
): Promise<void> {
  await tx
    .insert(sourceLinks)
    .values({
      ...tieRow(chargeId, qbStagedPaymentId),
      lifecycle: "confirmed",
      provenance: "human",
      confirmedByUserId,
      confirmedAt,
    })
    .onConflictDoUpdate({
      target: sourceLinks.id,
      set: {
        qbStagedPaymentId,
        lifecycle: "confirmed",
        provenance: "human",
        confirmedByUserId,
        confirmedAt,
        updatedAt: new Date(),
      },
    });
}

/** Delete a charge's tie row of ANY lifecycle (revert). */
export async function deleteChargeTie(tx: Tx, chargeId: string): Promise<void> {
  await tx
    .delete(sourceLinks)
    .where(eq(sourceLinks.id, sourceLinkId("charge_qb_tie", chargeId)));
}

/** Upsert the fee-row claim for a charge (always confirmed; the claim itself
 * is system-derived — the human confirmed the donor-line tie). */
export async function upsertChargeFeeRowLink(
  tx: Tx,
  chargeId: string,
  qbStagedPaymentId: string,
  confirmedByUserId: string | null,
  confirmedAt: Date = new Date(),
): Promise<void> {
  await tx
    .insert(sourceLinks)
    .values({
      id: sourceLinkId("charge_fee_row", chargeId),
      linkType: "charge_fee_row",
      stripeChargeId: chargeId,
      qbStagedPaymentId,
      lifecycle: "confirmed",
      provenance: "system_confirmed",
      confirmedByUserId,
      confirmedAt,
    })
    .onConflictDoUpdate({
      target: sourceLinks.id,
      set: {
        qbStagedPaymentId,
        confirmedByUserId,
        confirmedAt,
        updatedAt: new Date(),
      },
    });
}

/** Delete a charge's fee-row claim (revert). */
export async function deleteChargeFeeRowLink(
  tx: Tx,
  chargeId: string,
): Promise<void> {
  await tx
    .delete(sourceLinks)
    .where(eq(sourceLinks.id, sourceLinkId("charge_fee_row", chargeId)));
}

/** Upsert a Donorbox donation's counterpart claim (donorbox_qb or
 * donorbox_charge; always confirmed). */
export async function upsertDonorboxCounterpartLink(
  tx: Tx,
  linkType: Extract<SourceLink["linkType"], "donorbox_qb" | "donorbox_charge">,
  donorboxDonationId: string,
  counterpartId: string,
  confirmedByUserId: string | null,
  confirmedAt: Date = new Date(),
): Promise<void> {
  const counterpart =
    linkType === "donorbox_qb"
      ? { qbStagedPaymentId: counterpartId }
      : { stripeChargeId: counterpartId };
  await tx
    .insert(sourceLinks)
    .values({
      id: sourceLinkId(linkType, donorboxDonationId),
      linkType,
      donorboxDonationId,
      ...counterpart,
      lifecycle: "confirmed",
      provenance: confirmedByUserId ? "human" : "system_confirmed",
      confirmedByUserId,
      confirmedAt,
    })
    .onConflictDoUpdate({
      target: sourceLinks.id,
      set: {
        ...counterpart,
        provenance: confirmedByUserId ? "human" : "system_confirmed",
        confirmedByUserId,
        confirmedAt,
        updatedAt: new Date(),
      },
    });
}

/** Delete a Donorbox donation's counterpart claim (unlink). */
export async function deleteDonorboxCounterpartLink(
  tx: Tx,
  linkType: Extract<SourceLink["linkType"], "donorbox_qb" | "donorbox_charge">,
  donorboxDonationId: string,
): Promise<void> {
  await tx
    .delete(sourceLinks)
    .where(eq(sourceLinks.id, sourceLinkId(linkType, donorboxDonationId)));
}
