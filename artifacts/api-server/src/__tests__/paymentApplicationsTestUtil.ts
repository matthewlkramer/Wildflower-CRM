/**
 * Test-teardown helpers for the QuickBooks cash-application ledger
 * (`payment_applications`).
 *
 * The ledger's FKs to `staged_payments` (payment_id) and `gifts_and_payments`
 * (gift_id) are both `ON DELETE RESTRICT`, so any integration teardown that
 * deletes those parent rows must clear the ledger rows the test created FIRST.
 * Clearing by `payment_id` removes every row a QB test produced (each row is
 * anchored to a staged payment), which unblocks BOTH the staged-payment and the
 * gift deletes in the same teardown.
 *
 * Everything is loaded via dynamic `import()` so this module has no top-level
 * `@workspace/db` side effect — preserving the integration suites' "skip when no
 * real DATABASE_URL" pattern (the parent module throws at import if unset).
 */

/** Clear ledger rows anchored to every staged payment in a realm. */
export async function clearPaymentApplicationsForRealm(
  realmId: string,
): Promise<void> {
  const { db, paymentApplications, stagedPayments } = await import(
    "@workspace/db"
  );
  const { eq, inArray } = await import("drizzle-orm");
  await db.delete(paymentApplications).where(
    inArray(
      paymentApplications.paymentId,
      db
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(eq(stagedPayments.realmId, realmId)),
    ),
  );
}

/** Clear ledger rows anchored to an explicit set of staged-payment ids. */
export async function clearPaymentApplicationsForStagedIds(
  stagedIds: string[],
): Promise<void> {
  if (!stagedIds.length) return;
  const { db, paymentApplications } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  await db
    .delete(paymentApplications)
    .where(inArray(paymentApplications.paymentId, stagedIds));
}

/**
 * Ledger read-helpers for assertions — the legacy staged gift-link columns
 * (matched_gift_id / created_gift_id / group_reconciled_gift_id) and the
 * gift's final_amount_qb_staged_payment_id are @deprecated and never written,
 * so tests assert link state against the ledger instead.
 */

/** All counted QB ledger rows anchored to a staged payment. */
export async function qbCountedRowsForPayment(paymentId: string): Promise<
  Array<{
    giftId: string;
    amountApplied: string | null;
    createdTheGift: boolean;
    matchMethod: string;
  }>
> {
  const { db, paymentApplications } = await import("@workspace/db");
  const { and, eq } = await import("drizzle-orm");
  return db
    .select({
      giftId: paymentApplications.giftId,
      amountApplied: paymentApplications.amountApplied,
      createdTheGift: paymentApplications.createdTheGift,
      matchMethod: paymentApplications.matchMethod,
    })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.paymentId, paymentId),
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
 * The QB staged payment whose counted ledger row sources this gift's amount
 * (ledger replacement for the legacy gift.final_amount_qb_staged_payment_id).
 */
export async function qbPaymentIdForGift(
  giftId: string,
): Promise<string | null> {
  const { db, paymentApplications } = await import("@workspace/db");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const rows = await db
    .select({ paymentId: paymentApplications.paymentId })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.giftId, giftId),
        eq(paymentApplications.evidenceSource, "quickbooks"),
        eq(paymentApplications.linkRole, "counted"),
        isNotNull(paymentApplications.paymentId),
      ),
    );
  return rows.length === 1 ? rows[0].paymentId : null;
}

/**
 * Clear ledger rows anchored to an explicit set of gift ids.
 *
 * Needed for Stripe-evidence rows, which carry `payment_id = NULL` (they anchor
 * on `stripe_charge_id` + `gift_id`), so `clearPaymentApplicationsForStagedIds`
 * never reaches them. Because `stripe_charge_id`'s FK is `ON DELETE SET NULL`,
 * deleting the parent charge while such a row still exists nulls its
 * `stripe_charge_id` and trips the `payment_applications_stripe_evidence_chk`
 * CHECK — so a teardown that deletes charges/gifts must clear these FIRST.
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
}
