import { format, parseISO } from "date-fns";

export function formatCurrency(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(num)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    return format(parseISO(dateString), "MMM d, yy");
  } catch (e) {
    return dateString;
  }
}

export function formatEnum(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export const FUND_LABELS: Record<string, string> = {
  general_operating: "General Operating",
  seed_fund: "Seed Fund",
  black_wildflowers: "Black Wildflowers Fund",
  sunlight: "Sunlight (Loan Fund)",
};

export const CAPACITY_LABELS: Record<string, string> = {
  tier_1k_10k: "$1K–$10K",
  tier_10k_50k: "$10K–$50K",
  tier_50k_250k: "$50K–$250K",
  tier_250k_1m: "$250K–$1M",
  tier_1m_plus: "$1M+",
};

export function formatFund(fund: string | null | undefined): string {
  if (!fund) return "—";
  return FUND_LABELS[fund] || formatEnum(fund);
}

export function formatCapacity(capacity: string | null | undefined): string {
  if (!capacity) return "—";
  return CAPACITY_LABELS[capacity] || formatEnum(capacity);
}

/**
 * Compact funder-name renderer for **table cells only** — never use this on
 * detail pages where the funder is the subject of the view. Applies a
 * fixed sequence of word-boundary substitutions; order matters so plural
 * and compound forms are consumed before their singular roots:
 *   "Family Foundation" → "F.F."
 *   "Foundations"       → "Fnds"
 *   "Foundation"        → "Fnd"
 *   "Fundación"         → "Fnd"
 *   "Department"        → "Dept"
 *   "Education"         → "Educ"
 *   "Anonymous"         → "Anon"
 * Match is case-insensitive; the abbreviated form is emitted as written.
 */
export function formatFunderNameShort(
  name: string | null | undefined,
): string {
  if (!name) return "";
  const abbreviated = name
    .replace(/\bFamily Foundation\b/gi, "F.F.")
    .replace(/\bFoundations\b/gi, "Fnds")
    .replace(/\bFoundation\b/gi, "Fnd")
    .replace(/\bFundación\b/gi, "Fnd")
    .replace(/\bDepartment\b/gi, "Dept")
    .replace(/\bEducation\b/gi, "Educ")
    .replace(/\bAnonymous\b/gi, "Anon");
  // Funder names frequently embed a state ("Excellent Schools New Mexico",
  // "Texas Education Agency") — run the same state-abbreviation pass so
  // tables stay compact.
  return abbreviateUsStates(abbreviated);
}

/**
 * US state-name → USPS 2-letter code (case-insensitive, word-boundary).
 * Multi-word and " State" variants are listed first so they consume the
 * input before the single-word fallbacks fire (e.g. "New York State" →
 * "NY" before "New York"; "Washington State" → "WA" before "Washington").
 * "Washington (D.C.)" and "Washington, D.C." also collapse to "DC".
 * Non-state words are left untouched, so suffixes like "Bay Area" or
 * "Greater Boston" still render through.
 */
const US_STATE_ABBR: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bNew York State\b/gi, "NY"],
  [/\bWashington State\b/gi, "WA"],
  [/\bWashington \(D\.?C\.?\)/gi, "DC"],
  [/\bWashington, D\.?C\.?/gi, "DC"],
  [/\bNew Hampshire\b/gi, "NH"],
  [/\bNew Jersey\b/gi, "NJ"],
  [/\bNew Mexico\b/gi, "NM"],
  [/\bNew York\b/gi, "NY"],
  [/\bNorth Carolina\b/gi, "NC"],
  [/\bNorth Dakota\b/gi, "ND"],
  [/\bSouth Carolina\b/gi, "SC"],
  [/\bSouth Dakota\b/gi, "SD"],
  [/\bWest Virginia\b/gi, "WV"],
  [/\bRhode Island\b/gi, "RI"],
  [/\bPuerto Rico\b/gi, "PR"],
  [/\bAlabama\b/gi, "AL"],
  [/\bAlaska\b/gi, "AK"],
  [/\bArizona\b/gi, "AZ"],
  [/\bArkansas\b/gi, "AR"],
  [/\bCalifornia\b/gi, "CA"],
  [/\bColorado\b/gi, "CO"],
  [/\bConnecticut\b/gi, "CT"],
  [/\bDelaware\b/gi, "DE"],
  [/\bFlorida\b/gi, "FL"],
  [/\bGeorgia\b/gi, "GA"],
  [/\bHawaii\b/gi, "HI"],
  [/\bIdaho\b/gi, "ID"],
  [/\bIllinois\b/gi, "IL"],
  [/\bIndiana\b/gi, "IN"],
  [/\bIowa\b/gi, "IA"],
  [/\bKansas\b/gi, "KS"],
  [/\bKentucky\b/gi, "KY"],
  [/\bLouisiana\b/gi, "LA"],
  [/\bMaine\b/gi, "ME"],
  [/\bMaryland\b/gi, "MD"],
  [/\bMassachusetts\b/gi, "MA"],
  [/\bMichigan\b/gi, "MI"],
  [/\bMinnesota\b/gi, "MN"],
  [/\bMississippi\b/gi, "MS"],
  [/\bMissouri\b/gi, "MO"],
  [/\bMontana\b/gi, "MT"],
  [/\bNebraska\b/gi, "NE"],
  [/\bNevada\b/gi, "NV"],
  [/\bOhio\b/gi, "OH"],
  [/\bOklahoma\b/gi, "OK"],
  [/\bOregon\b/gi, "OR"],
  [/\bPennsylvania\b/gi, "PA"],
  [/\bTennessee\b/gi, "TN"],
  [/\bTexas\b/gi, "TX"],
  [/\bUtah\b/gi, "UT"],
  [/\bVermont\b/gi, "VT"],
  [/\bVirginia\b/gi, "VA"],
  [/\bWashington\b/gi, "WA"],
  [/\bWisconsin\b/gi, "WI"],
  [/\bWyoming\b/gi, "WY"],
];

export function abbreviateUsStates(s: string | null | undefined): string {
  if (!s) return "";
  let out = s;
  for (const [re, abbr] of US_STATE_ABBR) out = out.replace(re, abbr);
  return out;
}
