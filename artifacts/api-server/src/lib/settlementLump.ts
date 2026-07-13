import { stagedPayments } from "@workspace/db/schema";
import { eq, or, sql, type SQL } from "drizzle-orm";

/**
 * Shared "counts as a Stripe settlement lump" eligibility test.
 *
 * A Stripe payout's QB counterpart SHOULD be a `deposit`-typed staged row, but
 * the bookkeeper often mis-types the net lump as a generic `payment` row. Such
 * a mis-typed lump is still recognizable by a textual "stripe" signal across
 * the payer/memo/reference/account fields, or by a generic placeholder payer
 * name ("Misc Customer"). A donor-NAME payment row matches neither signal and
 * stays ineligible — that is a single donation and belongs at the charge grain.
 *
 * The proposal pass (stripeReconcile.ts), the pending-deposit confirm
 * transition (stripeConfirm.ts), and the Resolve manual-pick gate
 * (routes/reconciliation/bundleProposals.ts) MUST all use this ONE predicate so
 * a lump the matcher (or a human) can propose is always confirmable. The
 * propose pass keeps its own extra gates on top (e.g. single-charge payouts
 * still require a true deposit-typed row).
 *
 * The TS predicate and the SQL predicate below are the SAME rule in two
 * dialects — keep them in lockstep. Note the asymmetry: "stripe" is tested
 * against the full haystack, "misc" against payerName ONLY (a memo mentioning
 * "miscellaneous" must not qualify a donor payment).
 */

/** The staged-payment fields the lump test reads. */
export interface SettlementLumpFields {
  qbEntityType: string;
  payerName: string | null;
  lineDescription: string | null;
  qbTransactionMemo: string | null;
  rawReference: string | null;
  qbDepositToAccountName: string | null;
}

/** TS-side lump eligibility (mirror of {@link settlementLumpWhere}). */
export function isSettlementLump(row: SettlementLumpFields): boolean {
  if (row.qbEntityType === "deposit") return true;
  const hay = [
    row.payerName,
    row.lineDescription,
    row.qbTransactionMemo,
    row.rawReference,
    row.qbDepositToAccountName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (hay.includes("stripe")) return true;
  return (row.payerName ?? "").toLowerCase().includes("misc");
}

/** SQL-side lump eligibility over `staged_payments` (mirror of
 * {@link isSettlementLump}). */
export function settlementLumpWhere(): SQL {
  return or(
    eq(stagedPayments.qbEntityType, "deposit"),
    sql`lower(
      coalesce(${stagedPayments.payerName}, '') || ' ' ||
      coalesce(${stagedPayments.lineDescription}, '') || ' ' ||
      coalesce(${stagedPayments.qbTransactionMemo}, '') || ' ' ||
      coalesce(${stagedPayments.rawReference}, '') || ' ' ||
      coalesce(${stagedPayments.qbDepositToAccountName}, '')
    ) like '%stripe%'`,
    sql`lower(coalesce(${stagedPayments.payerName}, '')) like '%misc%'`,
  )!;
}
