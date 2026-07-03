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
