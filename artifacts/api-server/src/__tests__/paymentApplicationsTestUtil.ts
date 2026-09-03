/**
 * Test seed/read/teardown helpers for the unit→gift tie surface:
 * `payment_units.gift_id` + fact columns (the counted tie) and
 * `source_links` `unit_gift_corroboration` rows (corroboration + supersede
 * demotion crumbs). The retired `payment_applications` table is deliberately
 * absent from both fixtures and teardown.
 *
 * Everything is loaded via dynamic `import()` so this module has no top-level
 * `@workspace/db` side effect — preserving the integration suites' "skip when
 * no real DATABASE_URL" pattern (the parent module throws at import if unset).
 */

/** Clear the unit→gift tie facts for units pointing at the given gifts. */
async function detachUnitGiftPointersForGiftIds(
  giftIds: (string | null)[],
): Promise<void> {
  const ids = giftIds.filter((g): g is string => !!g);
  if (!ids.length) return;
  const { db, paymentUnits, sourceLinks } = await import("@workspace/db");
  const { inArray, and, eq } = await import("drizzle-orm");
  const { CLEARED_TIE_FACTS } = await import("../lib/paymentApplications");
  await db
    .delete(sourceLinks)
    .where(
      and(
        eq(sourceLinks.linkType, "unit_gift_corroboration"),
        inArray(sourceLinks.giftId, ids),
      ),
    );
  await db
    .update(paymentUnits)
    .set({ ...CLEARED_TIE_FACTS })
    .where(inArray(paymentUnits.giftId, ids));
}

/** Clear ties whose unit sources any staged payment in a realm. */
export async function clearPaymentApplicationsForRealm(
  realmId: string,
): Promise<void> {
  const { db, paymentUnits, stagedPayments } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ id: paymentUnits.id, giftId: paymentUnits.giftId })
    .from(paymentUnits)
    .innerJoin(
      stagedPayments,
      eq(paymentUnits.sourceStagedPaymentId, stagedPayments.id),
    )
    .where(eq(stagedPayments.realmId, realmId));
  await clearForUnits(rows);
}

async function clearForUnits(
  units: { id: string; giftId: string | null }[],
): Promise<void> {
  if (!units.length) return;
  const { db, paymentUnits, sourceLinks } = await import("@workspace/db");
  const { inArray, and, eq } = await import("drizzle-orm");
  const { CLEARED_TIE_FACTS } = await import("../lib/paymentApplications");
  const ids = units.map((u) => u.id);
  await db
    .delete(sourceLinks)
    .where(
      and(
        eq(sourceLinks.linkType, "unit_gift_corroboration"),
        inArray(sourceLinks.paymentUnitId, ids),
      ),
    );
  await db
    .update(paymentUnits)
    .set({ ...CLEARED_TIE_FACTS })
    .where(inArray(paymentUnits.id, ids));
  await detachUnitGiftPointersForGiftIds(units.map((u) => u.giftId));
}

/** Clear ties whose unit sources an explicit set of staged-payment ids. */
export async function clearPaymentApplicationsForStagedIds(
  stagedIds: string[],
): Promise<void> {
  if (!stagedIds.length) return;
  const { db, paymentUnits } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({ id: paymentUnits.id, giftId: paymentUnits.giftId })
    .from(paymentUnits)
    .where(inArray(paymentUnits.sourceStagedPaymentId, stagedIds));
  await clearForUnits(rows);
}

/**
 * Tie read-helpers for assertions — the legacy staged gift-link columns
 * (matched_gift_id / created_gift_id / group_reconciled_gift_id) and the
 * gift's final_amount_qb_staged_payment_id are @deprecated and never written,
 * so tests assert link state against the unit tie facts instead.
 */

/** All counted QB unit ties whose unit sources a staged payment. */
export async function qbCountedRowsForPayment(paymentId: string): Promise<
  Array<{
    giftId: string;
    amountApplied: string | null;
    createdTheGift: boolean;
    matchMethod: string;
  }>
> {
  const { db, paymentUnits } = await import("@workspace/db");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({
      giftId: paymentUnits.giftId,
      amountApplied: paymentUnits.grossAmount,
      createdTheGift: paymentUnits.createdTheGift,
      matchMethod: paymentUnits.giftMatchMethod,
    })
    .from(paymentUnits)
    .where(
      and(
        eq(paymentUnits.sourceStagedPaymentId, paymentId),
        isNotNull(paymentUnits.giftId),
      ),
    );
  return rows.map((r) => ({
    giftId: r.giftId as string,
    amountApplied: r.amountApplied,
    createdTheGift: r.createdTheGift,
    matchMethod: r.matchMethod ?? "system",
  }));
}

/** The single counted QB gift for a payment (null when none or split). */
export async function qbSoleGiftIdForPayment(
  paymentId: string,
): Promise<string | null> {
  const rows = await qbCountedRowsForPayment(paymentId);
  return rows.length === 1 ? rows[0].giftId : null;
}

/** The gift a payment MINTED (counted tie with created_the_gift), or null. */
export async function qbMintedGiftIdForPayment(
  paymentId: string,
): Promise<string | null> {
  const rows = await qbCountedRowsForPayment(paymentId);
  return rows.find((r) => r.createdTheGift)?.giftId ?? null;
}

/**
 * All supersede-DEMOTED ties whose unit sources a staged payment: preserved
 * as unit_gift_corroboration source_links with match_basis =
 * 'supersede_demotion' (so a revert can promote losslessly; corrections-flow
 * corroboration claims carry other bases and are excluded). After an approve
 * that books a covering per-charge Stripe tie and confirms the settlement
 * link, the coarse QB tie lands here instead of in `qbCountedRowsForPayment`.
 */
export async function qbDemotedRowsForPayment(paymentId: string): Promise<
  Array<{
    giftId: string;
    amountApplied: string | null;
    createdTheGift: boolean;
    matchMethod: string;
  }>
> {
  const { db, paymentUnits, sourceLinks } = await import("@workspace/db");
  const { and, eq } = await import("drizzle-orm");
  const rows = await db
    .select({
      giftId: sourceLinks.giftId,
      amountApplied: paymentUnits.grossAmount,
      provenance: sourceLinks.provenance,
    })
    .from(sourceLinks)
    .innerJoin(paymentUnits, eq(sourceLinks.paymentUnitId, paymentUnits.id))
    .where(
      and(
        eq(paymentUnits.sourceStagedPaymentId, paymentId),
        eq(sourceLinks.linkType, "unit_gift_corroboration"),
        eq(sourceLinks.matchBasis, "supersede_demotion"),
      ),
    );
  return rows.map((r) => ({
    giftId: r.giftId as string,
    amountApplied: r.amountApplied,
    createdTheGift: false,
    matchMethod: r.provenance,
  }));
}

/**
 * The QB staged payment whose counted unit tie sources this gift's amount
 * (tie replacement for the legacy gift.final_amount_qb_staged_payment_id).
 */
export async function qbPaymentIdForGift(
  giftId: string,
): Promise<string | null> {
  const { db, paymentUnits } = await import("@workspace/db");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({ paymentId: paymentUnits.sourceStagedPaymentId })
    .from(paymentUnits)
    .where(
      and(
        eq(paymentUnits.giftId, giftId),
        isNotNull(paymentUnits.sourceStagedPaymentId),
      ),
    );
  return rows.length === 1 ? rows[0].paymentId : null;
}

/**
 * Clear ties anchored to an explicit set of gift ids.
 *
 * Needed for Stripe-evidence ties, which `clearPaymentApplicationsForStagedIds`
 * never reaches (their unit sources a Stripe charge, not a staged payment).
 */
export async function clearPaymentApplicationsForGiftIds(
  giftIds: string[],
): Promise<void> {
  if (!giftIds.length) return;
  await detachUnitGiftPointersForGiftIds(giftIds);
}

/**
 * Seed a counted Stripe-evidence tie — the test replacement for the retired
 * `matched_gift_id` / `created_gift_id` pointer writes on
 * `stripe_staged_charges`. A charge is "booked" (match_confirmed /
 * match_proposed derivations, revert eligibility, ownership gates) if and
 * only if its unit carries the gift tie, so tests that used to seed the
 * pointers must seed this instead. Returns the payment unit id.
 */
export async function seedStripeApplication(args: {
  stripeChargeId: string;
  giftId: string;
  amountApplied?: string;
  createdTheGift?: boolean;
  matchMethod?: "system" | "system_confirmed" | "human";
  confirmedAt?: Date | null;
}): Promise<string> {
  const { db, paymentUnits } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const { ensurePaymentUnit } = await import("../lib/paymentUnits");
  const paymentUnitId = await ensurePaymentUnit(
    db,
    "stripe",
    args.stripeChargeId,
  );
  await db
    .update(paymentUnits)
    .set({
      giftId: args.giftId,
      giftMatchMethod: args.matchMethod ?? "human",
      giftConfirmedAt:
        args.confirmedAt === undefined ? new Date() : args.confirmedAt,
      createdTheGift: args.createdTheGift ?? false,
      updatedAt: new Date(),
    })
    .where(eq(paymentUnits.id, paymentUnitId));
  return paymentUnitId;
}

/**
 * Seed a counted QuickBooks-evidence tie — the test replacement for raw
 * `payment_applications` inserts (the ledger is retired and never written by
 * production code; guards and flags read `payment_units.gift_id`). A staged
 * payment is "booked" against a gift if and only if its unit carries the
 * gift tie. Returns the payment unit id.
 */
export async function seedQbApplication(args: {
  stagedPaymentId: string;
  giftId: string;
  amountApplied?: string;
  createdTheGift?: boolean;
  matchMethod?: "system" | "system_confirmed" | "human";
  confirmedAt?: Date | null;
}): Promise<string> {
  const { db, paymentUnits } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const { ensurePaymentUnit } = await import("../lib/paymentUnits");
  const paymentUnitId = await ensurePaymentUnit(
    db,
    "quickbooks",
    args.stagedPaymentId,
  );
  await db
    .update(paymentUnits)
    .set({
      giftId: args.giftId,
      giftMatchMethod: args.matchMethod ?? "human",
      giftConfirmedAt:
        args.confirmedAt === undefined ? new Date() : args.confirmedAt,
      createdTheGift: args.createdTheGift ?? false,
      updatedAt: new Date(),
    })
    .where(eq(paymentUnits.id, paymentUnitId));
  return paymentUnitId;
}

/**
 * Seed a counted Donorbox-evidence tie (Donorbox-only money — no Stripe
 * charge, no staged payment). Same pointer semantics as the Stripe/QB seeds.
 * Returns the payment unit id.
 */
export async function seedDonorboxApplication(args: {
  donorboxDonationId: string;
  giftId: string;
  createdTheGift?: boolean;
  matchMethod?: "system" | "system_confirmed" | "human";
  confirmedAt?: Date | null;
}): Promise<string> {
  const { db, paymentUnits } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const { ensurePaymentUnit } = await import("../lib/paymentUnits");
  const paymentUnitId = await ensurePaymentUnit(
    db,
    "donorbox",
    args.donorboxDonationId,
  );
  await db
    .update(paymentUnits)
    .set({
      giftId: args.giftId,
      giftMatchMethod: args.matchMethod ?? "human",
      giftConfirmedAt:
        args.confirmedAt === undefined ? new Date() : args.confirmedAt,
      createdTheGift: args.createdTheGift ?? false,
      updatedAt: new Date(),
    })
    .where(eq(paymentUnits.id, paymentUnitId));
  return paymentUnitId;
}

export async function unitIdForAnchor(
  evidenceSource: "quickbooks" | "stripe" | "donorbox",
  anchorId: string,
): Promise<string> {
  const { db } = await import("@workspace/db");
  const { ensurePaymentUnit } = await import("../lib/paymentUnits");
  return ensurePaymentUnit(db, evidenceSource, anchorId);
}

/**
 * The counted tie on a charge's unit (tie replacement for reading the retired
 * matched/created pointer columns in assertions).
 */
export async function stripeCountedRowForCharge(stripeChargeId: string): Promise<{
  giftId: string;
  amountApplied: string | null;
  createdTheGift: boolean;
} | null> {
  const { db, paymentUnits } = await import("@workspace/db");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({
      giftId: paymentUnits.giftId,
      amountApplied: paymentUnits.grossAmount,
      createdTheGift: paymentUnits.createdTheGift,
    })
    .from(paymentUnits)
    .where(
      and(
        eq(paymentUnits.stripeChargeId, stripeChargeId),
        isNotNull(paymentUnits.giftId),
      ),
    );
  return rows.length
    ? {
        giftId: rows[0].giftId as string,
        amountApplied: rows[0].amountApplied,
        createdTheGift: rows[0].createdTheGift,
      }
    : null;
}

/** The gift a charge is counted against (matched OR minted), or null. */
export async function stripeGiftIdForCharge(
  stripeChargeId: string,
): Promise<string | null> {
  const row = await stripeCountedRowForCharge(stripeChargeId);
  return row?.giftId ?? null;
}

/** The gift a charge MINTED (counted tie with created_the_gift), or null. */
export async function stripeMintedGiftIdForCharge(
  stripeChargeId: string,
): Promise<string | null> {
  const row = await stripeCountedRowForCharge(stripeChargeId);
  return row?.createdTheGift ? row.giftId : null;
}

/** Clear ties + ledger rows whose unit sources an explicit set of Stripe charge ids. */
export async function clearPaymentApplicationsForChargeIds(
  chargeIds: string[],
): Promise<void> {
  if (!chargeIds.length) return;
  const { db, paymentUnits } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({ id: paymentUnits.id, giftId: paymentUnits.giftId })
    .from(paymentUnits)
    .where(inArray(paymentUnits.stripeChargeId, chargeIds));
  await clearForUnits(rows);
}

/**
 * Clear canonical payment units minted for a set of Stripe charges (with their
 * deposit components and tie source_links). The post-sync
 * bank-spine recompute in a concurrently running suite can mint units for ANY
 * pending charge in the shared test DB, so a teardown that deletes its charges
 * must clear these RESTRICT-parented rows first.
 */
export async function clearPaymentUnitsForChargeIds(
  chargeIds: string[],
): Promise<void> {
  if (!chargeIds.length) return;
  const {
    db,
    bankDepositComponents,
    paymentUnits,
    sourceLinks,
  } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const unitIds = db
    .select({ id: paymentUnits.id })
    .from(paymentUnits)
    .where(inArray(paymentUnits.stripeChargeId, chargeIds));
  await db
    .delete(bankDepositComponents)
    .where(inArray(bankDepositComponents.paymentUnitId, unitIds));
  await db
    .delete(sourceLinks)
    .where(inArray(sourceLinks.paymentUnitId, unitIds));
  await db
    .delete(paymentUnits)
    .where(inArray(paymentUnits.stripeChargeId, chargeIds));
}

/**
 * Delete canonical payment units minted for a set of QB staged payments
 * (with their deposit components and tie source_links).
 * The staged FK is SET NULL, so deleting the payment would otherwise strand
 * an orphan unit in the shared test DB; delete the unit outright instead.
 */
export async function clearPaymentUnitsForStagedIds(
  stagedIds: string[],
): Promise<void> {
  if (!stagedIds.length) return;
  const {
    db,
    bankDepositComponents,
    paymentUnits,
    sourceLinks,
  } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const unitIds = db
    .select({ id: paymentUnits.id })
    .from(paymentUnits)
    .where(inArray(paymentUnits.sourceStagedPaymentId, stagedIds));
  await db
    .delete(bankDepositComponents)
    .where(inArray(bankDepositComponents.paymentUnitId, unitIds));
  await db
    .delete(sourceLinks)
    .where(inArray(sourceLinks.paymentUnitId, unitIds));
  await db
    .delete(paymentUnits)
    .where(inArray(paymentUnits.sourceStagedPaymentId, stagedIds));
}

/**
 * Delete canonical payment units minted for a set of Donorbox donations.
 * Same rationale as the staged variant (donation FK is SET NULL — deleting
 * the donation strands an orphan unit).
 */
export async function clearPaymentUnitsForDonorboxIds(
  donorboxDonationIds: string[],
): Promise<void> {
  if (!donorboxDonationIds.length) return;
  const {
    db,
    bankDepositComponents,
    paymentUnits,
    sourceLinks,
  } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const unitIds = db
    .select({ id: paymentUnits.id })
    .from(paymentUnits)
    .where(inArray(paymentUnits.donorboxDonationId, donorboxDonationIds));
  await db
    .delete(bankDepositComponents)
    .where(inArray(bankDepositComponents.paymentUnitId, unitIds));
  await db
    .delete(sourceLinks)
    .where(inArray(sourceLinks.paymentUnitId, unitIds));
  await db
    .delete(paymentUnits)
    .where(
      inArray(paymentUnits.donorboxDonationId, donorboxDonationIds),
    );
}
