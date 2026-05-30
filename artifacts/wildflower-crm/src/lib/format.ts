import { format, parseISO } from "date-fns";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/**
 * Decode HTML entities to their literal characters for plain-text display.
 *
 * Gmail's API returns HTML-escaped `snippet`/`subject`/body text (and the
 * Airtable import preserved that escaping), so values arrive containing
 * `&#39;`, `&lt;`, `&amp;`, etc. React renders strings verbatim, so without
 * decoding the user sees `It&#39;s` instead of `It's`. Output is rendered as
 * text by React (never via dangerouslySetInnerHTML), so decoding is safe — a
 * decoded `<script>` is shown as literal characters, not executed.
 *
 * Handles numeric (`&#39;`, `&#x27;`) and the common named entities. Unknown
 * entities are left untouched so genuine text isn't mangled.
 */
export function decodeHtmlEntities(
  input: string | null | undefined,
): string {
  if (!input) return input ?? "";
  return input.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const codePoint =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        if (!Number.isFinite(codePoint) || codePoint <= 0) return match;
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

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

/**
 * Long-form date for prose, headings, and detail-page footers.
 * "Jun 30, 2026" — pairs cleanly with surrounding sentences.
 */
export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    return format(parseISO(dateString), "MMM d, yyyy");
  } catch (e) {
    return dateString;
  }
}

/**
 * Compact numeric date for **table cells only** — keeps column widths
 * narrow on dense list views. "6/30/26".
 */
export function formatDateShort(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    return format(parseISO(dateString), "M/d/yy");
  } catch (e) {
    return dateString;
  }
}

/**
 * Render an ISO date-only string as a fiscal-year slug like "FY26".
 * Wildflower's fiscal year ends Jun 30 in America/Chicago — months
 * Jul–Dec belong to the next-year FY. Returns `null` for null/empty
 * or unparseable input so callers can render their own placeholder.
 */
export function fiscalYearFromDate(
  dateString: string | null | undefined,
): string | null {
  if (!dateString) return null;
  // Date-only strings ("YYYY-MM-DD") — parse the components directly to
  // sidestep any tz drift from `new Date("YYYY-MM-DD")`. Anything else
  // falls through to parseISO + UTC accessors, which is fine for the
  // date-time fields we never feed in here.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  let year: number;
  let month: number;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
  } else {
    try {
      const d = parseISO(dateString);
      year = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
    } catch {
      return null;
    }
  }
  const endYear = month >= 7 ? year + 1 : year;
  return `FY${String(endYear).slice(-2)}`;
}

/**
 * Render a snake_case enum value as a human label in **sentence case**:
 * only the first letter is capitalized, the rest stay lowercase. This
 * matches how the inline-edit dropdown labels read ("Have a connector"
 * rather than the older Title Case "Have A Connector").
 *
 * Use a dedicated formatter (`formatCapacity`, `formatFund`, …) for any
 * enum where the natural label needs special casing — capacity tiers
 * want "$10K–$50K", not "Tier 10k 50k".
 */
export function formatEnum(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.split("_").join(" ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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

/**
 * Strip a social media URL down to its handle / slug for compact
 * display in dense detail-page rows. Stored value remains the full
 * URL — these helpers only affect what's rendered.
 *
 * Best-effort: if the input isn't a recognizable URL for the
 * platform, we return it as-is (lightly trimmed) so manually-typed
 * handles still render. Returns "—" for empty input.
 */
function stripUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip protocol + leading "www." so the regex doesn't have to
  // care; also strip any trailing slash or query/hash noise.
  return trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[/?#].*$/, (m) => (m.startsWith("/") ? m : ""))
    .replace(/\/+$/, "");
}

export function formatLinkedinHandle(url: string | null | undefined): string {
  const s = stripUrl(url);
  if (!s) return "—";
  // linkedin.com/in/<slug>, /company/<slug>, /school/<slug>, /pub/<slug>
  const m = s.match(
    /^linkedin\.com\/(?:in|company|school|pub)\/([^/]+)/i,
  );
  if (m) return m[1];
  // Not a linkedin URL we recognize — fall back to the host-stripped
  // form, or the raw handle if there was no host at all.
  return s.replace(/^linkedin\.com\/?/i, "") || s;
}

export function formatXHandle(url: string | null | undefined): string {
  const s = stripUrl(url);
  if (!s) return "—";
  // x.com/<handle> or twitter.com/<handle>
  const m = s.match(/^(?:x|twitter)\.com\/([^/]+)/i);
  if (m) return `@${m[1]}`;
  // Already a bare handle (with or without leading @)
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(s)) return s.startsWith("@") ? s : `@${s}`;
  return s;
}

export function formatFacebookHandle(url: string | null | undefined): string {
  const s = stripUrl(url);
  if (!s) return "—";
  // facebook.com/<slug> or facebook.com/profile.php?id=<id>. We
  // already strip query strings in stripUrl, so profile.php IDs end
  // up as "profile.php" — fall back to that since there's no nicer
  // handle to show.
  const m = s.match(/^facebook\.com\/([^/]+)/i);
  if (m) return m[1];
  return s.replace(/^facebook\.com\/?/i, "") || s;
}

export function formatInstagramHandle(url: string | null | undefined): string {
  const s = stripUrl(url);
  if (!s) return "—";
  const m = s.match(/^instagram\.com\/([^/]+)/i);
  if (m) return `@${m[1]}`;
  if (/^@?[A-Za-z0-9_.]{1,30}$/.test(s)) return s.startsWith("@") ? s : `@${s}`;
  return s;
}

export function formatCrunchbaseHandle(
  url: string | null | undefined,
): string {
  const s = stripUrl(url);
  if (!s) return "—";
  // crunchbase.com/organization/<slug> or /person/<slug>
  const m = s.match(/^crunchbase\.com\/(?:organization|person)\/([^/]+)/i);
  if (m) return m[1];
  return s.replace(/^crunchbase\.com\/?/i, "") || s;
}
