// Pure helpers for seeding the gift-search box in the QuickBooks reconciler.
// Kept free of React / row-type coupling so they can be unit-tested directly.
// Everything here only affects the EDITABLE search-box seed — no persisted or
// displayed donor field is changed, so any imperfect guess is recoverable.

// Pass-through processors / DAFs that show up as the payer (or get auto-matched
// as the "donor") even though the real donor is named elsewhere on the record.
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
];

export function looksLikeIntermediary(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return PAYMENT_INTERMEDIARY_HINTS.some((h) => n.includes(h));
}

// Donations routed through an intermediary usually name the real donor in the
// same sentence as the processor, e.g. "Stripe donation - Angie Schiavoni",
// "Donorbox gift by Jane Doe", or "...Donor Advised Fund Gift from Nic and
// Lindsey Barnes, for Dahlia SF". Pull that name out of a free-text memo / line
// description so we can seed the gift search with the actual donor instead of
// the processor. Returns null when nothing confident is found (caller falls back
// to the payer/donor name). Conservative by design: no honorees, no generic
// phrases — when in doubt, return null.
export function donorNameFromMemo(
  text: string | null | undefined,
): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  // "...from/by <NAME>..." — the strongest signal. Capture a capitalized run
  // (allowing "and"/"&") and stop at a comma/period or a connective / descriptor
  // word (for/via/donation/gift/...), so trailing descriptors aren't captured.
  const fromMatch = cleaned.match(
    /\b(?:from|by)\s+([A-Z][^,.]*?)(?=\s+(?:for|via|through|to|in|at|on|by|donation|donations|gift|gifts|contribution|contributions|payment|payments|re)\b|[,.]|$)/,
  );
  const candidate =
    fromMatch?.[1] ?? cleaned.match(/-\s*([A-Z][A-Za-z.'&\- ]+)$/)?.[1];
  const trimmed = candidate?.replace(/[^A-Za-z.]+$/, "").trim();
  return trimmed ? trimmed : null;
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
