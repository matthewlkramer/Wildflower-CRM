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
 * Sole consumer today: the Resolve manual-pick gate
 * (routes/reconciliation/bundleProposals.ts). Any future lump-candidate read
 * MUST reuse this ONE predicate so a lump the system surfaces is always one a
 * human can pair. Note the asymmetry: "stripe" is tested against the full
 * haystack, "misc" against payerName ONLY (a memo mentioning "miscellaneous"
 * must not qualify a donor payment).
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

/** TS-side lump eligibility. */
export function isSettlementLump(row: SettlementLumpFields): boolean {
  // A deposit-typed row IS the lump by construction: a direct deposit LINE or
  // a WHOLE-deposit header record (deposit_header — staged when every line of
  // the bank deposit re-records ingested Payments, so the header carries the
  // deposit's date/total/account and is the only row that can be the lump).
  if (row.qbEntityType === "deposit" || row.qbEntityType === "deposit_header") {
    return true;
  }
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
