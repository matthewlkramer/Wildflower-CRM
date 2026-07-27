/**
 * Test-teardown helpers for the cash-application ledger
 * (`payment_applications`).
 *
 * The ledger's FKs to `payment_units` (payment_unit_id) and
 * `gifts_and_payments` (gift_id) are both `ON DELETE RESTRICT`, so any
 * integration teardown that deletes those parent rows must clear the ledger rows
 * the test created FIRST. Since the source-anchor columns were dropped
 * (bank-spine ADR), the ledger is anchored solely on `payment_unit_id`; the
 * source pointers (staged payment / Stripe charge) live on `payment_units`, so
 * these helpers resolve rows through the unit.
 *
 * Everything is loaded via dynamic `import()` so this module has no top-level
 * `@workspace/db` side effect — preserving the integration suites' "skip when no
 * real DATABASE_URL" pattern (the parent module throws at import if unset).
 *
 * `payment_units.gift_id` (the successor unit→gift pointer, ON DELETE
 * RESTRICT) is dual-written at booking time, so every clear helper also
 * detaches the pointer on the affected units — otherwise a teardown deleting
 * the gifts would trip the FK.
 */

/** Null out payment_units.gift_id for units pointing at the given gifts. */
async function detachUnitGiftPointersForGiftIds(
  giftIds: string[],
): Promise<void> {
  if (!giftIds.length) return;
  const { db, paymentUnits } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  await db
    .update(paymentUnits)
    .set({ giftId: null })
    .where(inArray(paymentUnits.giftId, giftIds));
}

/** Resolve the ledger-row ids whose unit sources one of the given QB payments. */
async function ledgerIdsForStagedIds(stagedIds: string[]): Promise<string[]> {
  const { db, paymentApplications, paymentUnits } = await import(
    "@workspace/db"
  );
  const { eq, inArray } = await import("drizzle-orm");
  const rows = await db
    .select({ id: paymentApplications.id })
    .from(paymentApplications)
    .innerJoin(
      paymentUnits,
      eq(paymentApplications.paymentUnitId, paymentUnits.id),
    )
    .where(inArray(paymentUnits.sourceStagedPaymentId, stagedIds));
  return rows.map((r) => r.id);
}

/** Clear ledger rows whose unit sources any staged payment in a realm. */
export async function clearPaymentApplicationsForRealm(
  realmId: string,
): Promise<void> {
  const { db, paymentApplications, paymentUnits, stagedPayments } =
    await import("@workspace/db");
  const { eq, inArray } = await import("drizzle-orm");
  const rows = await db
    .select({ id: paymentApplications.id })
    .from(paymentApplications)
    .innerJoin(
      paymentUnits,
      eq(paymentApplications.paymentUnitId, paymentUnits.id),
    )
    .innerJoin(
      stagedPayments,
      eq(paymentUnits.sourceStagedPaymentId, stagedPayments.id),
    )
    .where(eq(stagedPayments.realmId, realmId));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  const giftRows = await db
    .select({ giftId: paymentApplications.giftId })
    .from(paymentApplications)
    .where(inArray(paymentApplications.id, ids));
  await db
    .delete(paymentApplications)
    .where(inArray(paymentApplications.id, ids));
  await detachUnitGiftPointersForGiftIds(giftRows.map((r) => r.giftId));
}

/** Clear ledger rows whose unit sources an explicit set of staged-payment ids. */
export async function clearPaymentApplicationsForStagedIds(
  stagedIds: string[],
): Promise<void> {
  if (!stagedIds.length) return;
  const ids = await ledgerIdsForStagedIds(stagedIds);
  if (!ids.length) return;
  const { db, paymentApplications } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const giftRows = await db
    .select({ giftId: paymentApplications.giftId })
    .from(paymentApplications)
    .where(inArray(paymentApplications.id, ids));
  await db
    .delete(paymentApplications)
    .where(inArray(paymentApplications.id, ids));
  await detachUnitGiftPointersForGiftIds(giftRows.map((r) => r.giftId));
}

/**
 * Ledger read-helpers for assertions — the legacy staged gift-link columns
 * (matched_gift_id / created_gift_id / group_reconciled_gift_id) and the
 * gift's final_amount_qb_staged_payment_id are @deprecated and never written,
 * so tests assert link state against the ledger instead.
 */

/** All counted QB ledger rows whose unit sources a staged payment. */
export async function qbCountedRowsForPayment(paymentId: string): Promise<
  Array<{
    giftId: string;
    amountApplied: string | null;
    createdTheGift: boolean;
    matchMethod: string;
  }>
> {
  const { db, paymentApplications, paymentUnits } = await import(
    "@workspace/db"
  );
  const { and, eq } = await import("drizzle-orm");
  return db
    .select({
      giftId: paymentApplications.giftId,
      amountApplied: paymentApplications.amountApplied,
      createdTheGift: paymentApplications.createdTheGift,
      matchMethod: paymentApplications.matchMethod,
    })
    .from(paymentApplications)
    .innerJoin(
      paymentUnits,
      eq(paymentApplications.paymentUnitId, paymentUnits.id),
    )
    .where(
      and(
        eq(paymentUnits.sourceStagedPaymentId, paymentId),
        eq(paymentApplications.evidenceSource, "quickbooks"),
        eq(paymentApplications.linkRole, "counted"),
      ),
    );
}

/** The single counted QB gift for a payment (null when none or split). */
export async function qbSoleGiftIdForPayment(
  paymentId: string,
): Promise<string | null> {
  const rows = await qbCountedRowsForPayment(paymentId);
  return rows.length === 1 ? rows[0].giftId : null;
}

/** The gift a payment MINTED (counted QB row with created_the_gift), or null. */
export async function qbMintedGiftIdForPayment(
  paymentId: string,
): Promise<string | null> {
  const rows = await qbCountedRowsForPayment(paymentId);
  return rows.find((r) => r.createdTheGift)?.giftId ?? null;
}

/**
 * All supersede-DEMOTED QB ledger rows whose unit sources a staged payment:
 * corroborating WITH an amount (the §4.3 settlement-supersede demote keeps the
 * amount so a revert can promote losslessly; corrections-flow corroborating
 * rows carry a NULL amount and are excluded). After an approve that books a
 * covering per-charge Stripe row and confirms the settlement link, the coarse
 * QB row lands here instead of in `qbCountedRowsForPayment`.
 */
export async function qbDemotedRowsForPayment(paymentId: string): Promise<
  Array<{
    giftId: string;
    amountApplied: string | null;
    createdTheGift: boolean;
    matchMethod: string;
  }>
> {
  const { db, paymentApplications, paymentUnits } = await import(
    "@workspace/db"
  );
  const { and, eq, isNotNull } = await import("drizzle-orm");
  return db
    .select({
      giftId: paymentApplications.giftId,
      amountApplied: paymentApplications.amountApplied,
      createdTheGift: paymentApplications.createdTheGift,
      matchMethod: paymentApplications.matchMethod,
    })
    .from(paymentApplications)
    .innerJoin(
      paymentUnits,
      eq(paymentApplications.paymentUnitId, paymentUnits.id),
    )
    .where(
      and(
        eq(paymentUnits.sourceStagedPaymentId, paymentId),
        eq(paymentApplications.evidenceSource, "quickbooks"),
        eq(paymentApplications.linkRole, "corroborating"),
        isNotNull(paymentApplications.amountApplied),
      ),
    );
}

/**
 * The QB staged payment whose counted ledger row sources this gift's amount
 * (ledger replacement for the legacy gift.final_amount_qb_staged_payment_id).
 */
export async function qbPaymentIdForGift(
  giftId: string,
): Promise<string | null> {
  const { db, paymentApplications, paymentUnits } = await import(
    "@workspace/db"
  );
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({ paymentId: paymentUnits.sourceStagedPaymentId })
    .from(paymentApplications)
    .innerJoin(
      paymentUnits,
      eq(paymentApplications.paymentUnitId, paymentUnits.id),
    )
    .where(
      and(
        eq(paymentApplications.giftId, giftId),
        eq(paymentApplications.evidenceSource, "quickbooks"),
        eq(paymentApplications.linkRole, "counted"),
        isNotNull(paymentUnits.sourceStagedPaymentId),
      ),
    );
  return rows.length === 1 ? rows[0].paymentId : null;
}

/**
 * Clear ledger rows anchored to an explicit set of gift ids.
 *
 * Needed for Stripe-evidence rows, which `clearPaymentApplicationsForStagedIds`
 * never reaches (their unit sources a Stripe charge, not a staged payment).
 * `payment_unit_id`'s FK is `ON DELETE RESTRICT`, so a teardown that deletes the
 * parent unit must clear these ledger rows FIRST.
 */
export async function clearPaymentApplicationsForGiftIds(
  giftIds: string[],
): Promise<void> {
  if (!giftIds.length) return;
  const { db, paymentApplications } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  await db
    .delete(paymentApplications)
    .where(inArray(paymentApplications.giftId, giftIds));
  await detachUnitGiftPointersForGiftIds(giftIds);
}

/**
 * Seed a counted Stripe-evidence ledger row — the test replacement for the
 * retired `matched_gift_id` / `created_gift_id` pointer writes on
 * `stripe_staged_charges`. A charge is "booked" (match_confirmed /
 * match_proposed derivations, revert eligibility, ownership gates) if and only
 * if such a row exists, so tests that used to seed the pointers must seed
 * this instead. `link_role`/`lifecycle` keep their column defaults
 * (counted / confirmed), matching every production write path.
 */
export async function seedStripeApplication(args: {
  stripeChargeId: string;
  giftId: string;
  amountApplied: string;
  createdTheGift?: boolean;
  matchMethod?: "system" | "system_confirmed" | "human";
  confirmedAt?: Date | null;
}): Promise<string> {
  const { db, paymentApplications } = await import("@workspace/db");
  const { ensurePaymentUnit } = await import("../lib/paymentUnits");
  const id = `patest_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const paymentUnitId = await ensurePaymentUnit(
    db,
    "stripe",
    args.stripeChargeId,
  );
  await db.insert(paymentApplications).values({
    id,
    giftId: args.giftId,
    amountApplied: args.amountApplied,
    evidenceSource: "stripe",
    paymentUnitId,
    matchMethod: args.matchMethod ?? "human",
    confirmedAt: args.confirmedAt === undefined ? new Date() : args.confirmedAt,
    createdTheGift: args.createdTheGift ?? false,
  });
  return id;
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
 * The counted Stripe ledger row whose unit sources a charge (ledger replacement
 * for reading the retired matched/created pointer columns in assertions).
 */
export async function stripeCountedRowForCharge(stripeChargeId: string): Promise<{
  giftId: string;
  amountApplied: string | null;
  createdTheGift: boolean;
} | null> {
  const { db, paymentApplications, paymentUnits } = await import(
    "@workspace/db"
  );
  const { and, eq } = await import("drizzle-orm");
  const rows = await db
    .select({
      giftId: paymentApplications.giftId,
      amountApplied: paymentApplications.amountApplied,
      createdTheGift: paymentApplications.createdTheGift,
    })
    .from(paymentApplications)
    .innerJoin(
      paymentUnits,
      eq(paymentApplications.paymentUnitId, paymentUnits.id),
    )
    .where(
      and(
        eq(paymentUnits.stripeChargeId, stripeChargeId),
        eq(paymentApplications.evidenceSource, "stripe"),
        eq(paymentApplications.linkRole, "counted"),
      ),
    );
  return rows.length ? rows[0] : null;
}

/** The gift a charge is counted against (matched OR minted), or null. */
export async function stripeGiftIdForCharge(
  stripeChargeId: string,
): Promise<string | null> {
  const row = await stripeCountedRowForCharge(stripeChargeId);
  return row?.giftId ?? null;
}

/** The gift a charge MINTED (counted row with created_the_gift), or null. */
export async function stripeMintedGiftIdForCharge(
  stripeChargeId: string,
): Promise<string | null> {
  const row = await stripeCountedRowForCharge(stripeChargeId);
  return row?.createdTheGift ? row.giftId : null;
}

/** Clear ledger rows whose unit sources an explicit set of Stripe charge ids. */
export async function clearPaymentApplicationsForChargeIds(
  chargeIds: string[],
): Promise<void> {
  if (!chargeIds.length) return;
  const { db, paymentApplications, paymentUnits } = await import(
    "@workspace/db"
  );
  const { eq, inArray } = await import("drizzle-orm");
  const rows = await db
    .select({ id: paymentApplications.id })
    .from(paymentApplications)
    .innerJoin(
      paymentUnits,
      eq(paymentApplications.paymentUnitId, paymentUnits.id),
    )
    .where(inArray(paymentUnits.stripeChargeId, chargeIds));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  const giftRows = await db
    .select({ giftId: paymentApplications.giftId })
    .from(paymentApplications)
    .where(inArray(paymentApplications.id, ids));
  await db
    .delete(paymentApplications)
    .where(inArray(paymentApplications.id, ids));
  await detachUnitGiftPointersForGiftIds(giftRows.map((r) => r.giftId));
}

/**
 * Clear canonical payment units minted for a set of Stripe charges (with their
 * deposit components and ledger rows). The post-sync bank-spine recompute in a
 * concurrently running suite can mint units for ANY pending charge in the
 * shared test DB, so a teardown that deletes its charges must clear these
 * RESTRICT-parented rows first. `payment_unit_id` is NOT NULL, so the ledger
 * rows are deleted (not detached) before their units go.
 */
export async function clearPaymentUnitsForChargeIds(
  chargeIds: string[],
): Promise<void> {
  if (!chargeIds.length) return;
  const { db, bankDepositComponents, paymentApplications, paymentUnits } =
    await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const unitIds = db
    .select({ id: paymentUnits.id })
    .from(paymentUnits)
    .where(inArray(paymentUnits.stripeChargeId, chargeIds));
  await db
    .delete(bankDepositComponents)
    .where(inArray(bankDepositComponents.paymentUnitId, unitIds));
  await db
    .delete(paymentApplications)
    .where(inArray(paymentApplications.paymentUnitId, unitIds));
  await db
    .delete(paymentUnits)
    .where(inArray(paymentUnits.stripeChargeId, chargeIds));
}
