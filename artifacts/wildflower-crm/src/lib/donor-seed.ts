// Pure helpers for seeding the gift-search box in the QuickBooks reconciler.
// Kept free of React / row-type coupling so they can be unit-tested directly.
// Everything here only affects the EDITABLE search-box seed — no persisted or
// displayed donor field is changed, so any imperfect guess is recoverable.

// Pass-through processors / DAFs that show up as the payer (or get auto-matched
// as the "donor") even though the real donor is named elsewhere on the record.
// The named DAF sponsors (Fidelity / Schwab / Vanguard Charitable, ...) and the
// bill.com rail were added after auditing real production memos that named the
// sponsor as the payer while the actual donor appeared in the memo text.
export const PAYMENT_INTERMEDIARY_HINTS = [
  "stripe",
  "donorbox",
  "paypal",
  "benevity",
  "classy",
  "givebutter",
  "every.org",
  "network for good",
  "donor advised",
  "donor-advised",
  "charitable giving fund",
  "charitable gift fund",
  "daf",
  "bill.com",
  "fidelity charitable",
  "schwab charitable",
  "vanguard charitable",
];

export function looksLikeIntermediary(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return PAYMENT_INTERMEDIARY_HINTS.some((h) => n.includes(h));
}

// Tokens that look like a leading "donor" but never are: anonymity masks
// ("Anonymous"), donor *categories* ("Individual Donations ..."), employee-expense
// markers ("EE Donation ..."), and transaction descriptors ("Gross ...",
// "Recurring donation ..."). A leading-name / charge match on one of these is
// rejected so we fall back to the payer instead of seeding a bogus donor.
// Drawn from a production audit of real Stripe/Donorbox/DAF memos.
const NON_DONOR_LEADING_WORDS = new Set([
  "anonymous",
  "individual",
  "individuals",
  "ee",
  "online",
  "recurring",
  "monthly",
  "misc",
  "general",
  "gen",
  "total",
  "bank",
  "fee",
  "fees",
  "gross",
  "second",
  "matching",
  "employee",
  "this",
]);

// Accept a raw capture as a donor seed only if it survives trailing-junk trim and
// is neither a payment intermediary nor a known non-donor token. Shared by the
// leading-name and "Charge for ..." paths.
function acceptDonorCandidate(raw: string | undefined): string | null {
  const trimmed = raw?.replace(/[^A-Za-z.]+$/, "").trim();
  if (!trimmed) return null;
  if (looksLikeIntermediary(trimmed)) return null;
  if (NON_DONOR_LEADING_WORDS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

// Donations routed through an intermediary usually name the real donor in the
// same sentence as the processor. A production audit of real memos showed several
// recurring phrasings, handled here in confidence order:
//   1. "...from/by <NAME>..."             — "Donor Advised Fund Gift from Nic and
//                                            Lindsey Barnes, for Dahlia SF"
//   2. trailing " - <NAME>"               — "Stripe donation - Angie Schiavoni"
//   3. leading "<NAME> donation/gift..."  — "Erica Cantoni donation via Stripe",
//                                            "Alexander Brown donation to BWF"
//   4. "Charge(s) for <NAME>"             — "Charge for Michelle Yang"
// Pull that name out of a free-text memo / line description so we can seed the
// gift search with the actual donor instead of the processor. Returns null when
// nothing confident is found (caller falls back to the payer/donor name).
// Conservative by design: no honorees, no "in honor/memory of", and multi-donor
// splits ("Charges- Lutterman, Auletta, Hollenback") deliberately yield null so
// we never seed just one of several donors.
export function donorNameFromMemo(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  // 1. "...from/by <NAME>..." — the strongest signal. Capture a capitalized run
  // (allowing "and"/"&") and stop at a comma/period or a connective / descriptor
  // word (for/via/donation/gift/...), so trailing descriptors aren't captured.
  const fromMatch = cleaned.match(
    /\b(?:from|by)\s+([A-Z][^,.]*?)(?=\s+(?:for|via|through|to|in|at|on|by|donation|donations|gift|gifts|contribution|contributions|payment|payments|re)\b|[,.]|$)/,
  );
  // 2. trailing " - <NAME>" at the end of the string. Require whitespace after the
  // dash so intra-name hyphens ("Mendez-Ortiz") are not mistaken for a delimiter.
  const dashMatch = cleaned.match(/-\s+([A-Z][A-Za-z.'&\- ]+)$/);
  const primary = (fromMatch?.[1] ?? dashMatch?.[1])
    ?.replace(/[^A-Za-z.]+$/, "")
    .trim();
  if (primary) return primary;

  // 3. leading "<NAME> donation/gift/contribution ..." — donor named first, e.g.
  // "Erica Cantoni donation via Stripe". Capture a short capitalized run, then the
  // donation keyword; reject intermediaries ("Stripe donation") and non-donor
  // categories ("Anonymous donation", "Individual Donations ...") via the guard.
  const leadingMatch = cleaned.match(
    /^([A-Z][A-Za-z.'&\-]*(?:\s+(?:and|&|[A-Z][A-Za-z.'&\-]*)){0,3})\s+(?:[Dd]onations?|[Gg]ifts?|[Cc]ontributions?)\b/,
  );
  const leading = acceptDonorCandidate(leadingMatch?.[1]);
  if (leading) return leading;

  // 4. "Charge(s) for <NAME>" at the start — the person whose card was charged,
  // e.g. "Charge for Michelle Yang". Anchored to the start so it never fires on
  // expense/refund memos ("Disputed delta charge, ...").
  const chargeMatch = cleaned.match(
    /^[Cc]harges?\s+for\s+([A-Z][A-Za-z.'&\-]*(?:\s+(?:and|&|[A-Z][A-Za-z.'&\-]*)){0,3})\b/,
  );
  return acceptDonorCandidate(chargeMatch?.[1]);
}

// Generic org words that add no matching value. Dropping them from a multi-word
// seed makes a long formal name match the short way donors are usually recorded
// (e.g. "CityBridge Foundation" → "CityBridge"). Trailing punctuation is stripped
// before comparison so "Inc." and "Co." also match.
export const GENERIC_ORG_WORDS = new Set([
  "the",
  "foundation",
  "foundations",
  "fund",
  "funds",
  "trust",
  "charitable",
  "charity",
  "charities",
  "inc",
  "llc",
  "co",
  "company",
  "corp",
  "corporation",
  "incorporated",
  "ltd",
  "limited",
  "philanthropies",
  "philanthropy",
]);

// Reduce a multi-word seed name to its essential token(s) by dropping a leading
// "The" and any generic org words (Foundation, Fund, Trust, Inc, LLC, ...).
// Conservative: single-word names are returned unchanged, and if trimming would
// leave nothing (every word was generic), the original is kept.
export function trimToEssentialName(name: string): string {
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (!cleaned) return name;
  const words = cleaned.split(" ");
  if (words.length <= 1) return cleaned;
  const kept = words.filter(
    (w) => !GENERIC_ORG_WORDS.has(w.toLowerCase().replace(/[.,]+$/, "")),
  );
  if (kept.length === 0) return cleaned;
  return kept.join(" ");
}
