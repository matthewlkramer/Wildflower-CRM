/**
 * Pure inference of a staged payment's FUNDING SOURCE — the money's origin /
 * processor (Stripe, a DAF, a brokerage stock transfer, Donorbox, PayPal, a
 * wire/ACH, a paper check, …). This is deliberately distinct from two nearby
 * concepts:
 *
 *   - `qbPaymentMethod` is the raw QuickBooks "payment method" instrument string
 *     (Check / Cash / Credit Card / …). It is an instrument, not an origin: a
 *     "Credit Card" row could be Stripe, PayPal, or a direct terminal charge.
 *   - the reconcile *lane* (matched / suggested / unmatched / excluded / …) is
 *     review status, not where the money came from.
 *
 * The result feeds the `funding_source` column. It is seeded automatically at
 * ingest (provenance `auto`) and is freely human-correctable (provenance
 * `manual`); a `manual` value is review state and is never overwritten by this
 * helper on a re-pull / reclassify.
 *
 * PURE: no DB, no I/O. All signals are passed in. Returns `null` when nothing is
 * conclusive — we never guess `other`; `other` is reserved for a human pinning a
 * known-but-unlisted origin by hand.
 */
import { stagedPaymentFundingSourceEnum } from "@workspace/db/schema";

export type FundingSource =
  (typeof stagedPaymentFundingSourceEnum.enumValues)[number];

export interface FundingSourceInput {
  /** QB payer / customer display name (often the processor or DAF sponsor). */
  payerName: string | null;
  /** Raw QB payment-method instrument string (Check / Cash / Credit Card / …). */
  qbPaymentMethod: string | null;
  /** Free-text memo / reference captured on the row. */
  rawReference: string | null;
  /** Per-line description (deposit line Description / CustomerMemo). */
  lineDescription?: string | null;
  /** QB transaction-level memo (PrivateNote). */
  qbTransactionMemo?: string | null;
  /** Name of the bank/clearing account the money was deposited to. */
  qbDepositToAccountName?: string | null;
  /**
   * Canonical type of the payment intermediary the payer resolved to, when
   * known (from `payment_intermediaries.type`). Only `daf` is conclusive on its
   * own; `giving_platform` / `private_wealth_manager` are too broad to name a
   * specific origin, so they are left to the text signals.
   */
  intermediaryType?: "daf" | "giving_platform" | "private_wealth_manager" | null;
  /**
   * True when reconciliation evidence ties this row to Stripe charges (i.e. a
   * Stripe payout/charge links to it). The strongest possible signal — when
   * present it wins outright. Usually only known at reconcile/backfill time, not
   * at first ingest.
   */
  hasStripeEvidence?: boolean;
}

// Ordered, specific text signals. Each names a concrete origin; order resolves
// the (rare) case where more than one would match. Kept intentionally narrow —
// multiword where a bare word would be ambiguous (e.g. "stock transfer", not
// "stock") — so an auto guess is conservative and a human only ever has to
// correct, never untangle, a wrong default.
const TEXT_SIGNALS: ReadonlyArray<readonly [FundingSource, RegExp]> = [
  ["stripe", /\bstripe\b/i],
  ["donorbox", /donor\s?box/i],
  ["paypal", /\bpay\s?pal\b/i],
  [
    "employer_match",
    /\b(employer\s+match|matching\s+gift|benevity|your\s?cause|cyber\s?grants|double\s+the\s+donation|bright\s?funds|givinga)\b/i,
  ],
  [
    "daf",
    /\b(donor[-\s]?advised|daf|fidelity\s+charitable|schwab\s+charitable|vanguard\s+charitable|national\s+philanthropic|np\s?trust|american\s+endowment|renaissance\s+charitable|greater\s+horizons)\b/i,
  ],
  [
    "brokerage",
    /\b(brokerage|stock\s+(gift|transfer|donation)|gift\s+of\s+stock|securities|shares\s+of|dtc\s+transfer|in[-\s]?kind\s+securities)\b/i,
  ],
];

/** Map the raw QB instrument string to an origin, when it implies one. */
function fromPaymentMethod(method: string): FundingSource | null {
  const m = method.toLowerCase();
  if (/check|cheque|e-?check/.test(m)) return "check";
  if (/\bcash\b/.test(m)) return "cash";
  if (/wire|\bach\b|\beft\b|bank\s*transfer|electronic\s+funds/.test(m)) {
    return "wire_ach";
  }
  // "Credit Card" and friends are intentionally inconclusive: the instrument
  // does not name the processor (could be Stripe / PayPal / direct). Leave null.
  return null;
}

/**
 * Infer the funding source from the available signals, in priority order:
 *   1. explicit Stripe reconciliation evidence  → `stripe`
 *   2. a named origin in any free-text field     → that origin
 *   3. a DAF-typed payment intermediary          → `daf`
 *   4. the QB payment-method instrument          → check / cash / wire_ach
 *   5. otherwise                                 → null (unknown)
 */
export function detectFundingSource(
  input: FundingSourceInput,
): FundingSource | null {
  if (input.hasStripeEvidence) return "stripe";

  const haystack = [
    input.payerName,
    input.rawReference,
    input.lineDescription,
    input.qbTransactionMemo,
    input.qbDepositToAccountName,
  ]
    .filter((s): s is string => !!s)
    .join(" \u0001 ");

  if (haystack) {
    for (const [source, re] of TEXT_SIGNALS) {
      if (re.test(haystack)) return source;
    }
  }

  if (input.intermediaryType === "daf") return "daf";

  if (input.qbPaymentMethod) {
    const byMethod = fromPaymentMethod(input.qbPaymentMethod);
    if (byMethod) return byMethod;
  }

  return null;
}
