// Pure parsing helpers for the one-time Donation Coding Form import (no DB / no
// xlsx import here — the runner loads xlsx and feeds raw cell rows in). Kept
// side-effect free so the mapping logic is testable in isolation.

export type CodingFormSource = "fy24" | "fy25" | "fy26" | "girasol";

export interface ParsedCodingFormRow {
  source: CodingFormSource;
  sourceRowIndex: number;
  rawData: Record<string, unknown>;
  donorNameRaw: string | null;
  internalMemo: string | null;
  donorTypeRaw: string | null;
  seriesTypeRaw: string | null;
  restrictionLanguage: string | null;
  donorNameAddressRaw: string | null;
  reportRequiredRaw: string | null;
  driveLink: string | null;
  circleRaw: string | null;
  additionalNotes: string | null;
  paymentMethodRaw: string | null;
  stripeFeesRaw: string | null;
  classRaw: string | null;
  submitterEmail: string | null;
  wildflowerPartner: string | null;
  amount: string | null;
  donationDate: string | null;
  depositDate: string | null;
  addrStreet: string | null;
  addrCity: string | null;
  addrState: string | null;
  addrPostal: string | null;
  addrCountry: string | null;
  reportRequired: boolean | null;
  reportDueDate: string | null;
  intendedUsageSuggested:
    | "gen_ops"
    | "growth"
    | "school_startup"
    | "teacher_training"
    | "project"
    | null;
}

// ── Cell coercion ──────────────────────────────────────────────────────────

function s(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length === 0 ? null : t;
}

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR","VI","GU",
]);

// Parse "$5,000" / "5000.50" / "1,234" → "5000.00" (string numeric). Non-numeric
// (e.g. the FY26 "Test" junk rows) → null.
export function parseAmount(v: unknown): string | null {
  const raw = s(v);
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

// Parse a leading date out of free text: M/D/YYYY (+ optional time), YYYY-MM-DD,
// or "Month DD, YYYY". Returns an ISO date string (YYYY-MM-DD) or null.
export function parseDate(v: unknown): string | null {
  const raw = s(v);
  if (!raw) return null;

  // M/D/YYYY or M/D/YY (optionally followed by a time)
  const slash = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slash) {
    let [, mo, da, yr] = slash;
    let year = Number(yr);
    if (year < 100) year += 2000;
    const m = Number(mo);
    const d = Number(da);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // ISO YYYY-MM-DD
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "December 31, 2024" / "Dec 31 2024"
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const word = raw.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (word) {
    const mo = months[word[1].slice(0, 3).toLowerCase()];
    const d = Number(word[2]);
    const year = Number(word[3]);
    if (mo && d >= 1 && d <= 31) {
      return `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return null;
}

const NEGATIVE_REPORT = new Set([
  "n/a","na","no","none","no.","not required","no report","no report needed",
]);

// Interpret the "Does this grant require a written report? If yes, by what
// date?" free-text answer. Returns { required, dueDate }. `required` is null
// when the answer is too ambiguous to classify (left for a human decision).
export function parseReport(v: unknown): {
  required: boolean | null;
  dueDate: string | null;
} {
  const raw = s(v);
  if (!raw) return { required: false, dueDate: null };
  const lower = raw.toLowerCase();
  const dueDate = parseDate(raw);

  if (NEGATIVE_REPORT.has(lower)) return { required: false, dueDate: null };
  // Explicitly negative phrasings ("No, only a letter for tax purposes").
  if (/^no\b/.test(lower) && !dueDate) return { required: false, dueDate: null };
  if (dueDate) return { required: true, dueDate };
  if (/^yes\b|required|report/.test(lower)) return { required: true, dueDate: null };
  // A "letter for tax purposes" is an acknowledgment, not a grant report.
  if (/letter|tax purpose|receipt|acknowledg/.test(lower) && !/report/.test(lower)) {
    return { required: false, dueDate: null };
  }
  return { required: null, dueDate };
}

// Conservative intended-usage suggestion from the memo + restriction language.
// Returns null when nothing maps confidently (the reviewer decides).
export function suggestIntendedUsage(
  ...texts: (string | null)[]
): ParsedCodingFormRow["intendedUsageSuggested"] {
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  if (!hay) return null;
  if (/start[\s-]?up/.test(hay)) return "school_startup";
  if (/teacher training/.test(hay)) return "teacher_training";
  if (/\bgrowth\b/.test(hay)) return "growth";
  if (/\bgen(eral)?[\s-]?op|general operating|operations\b/.test(hay)) return "gen_ops";
  return null;
}

// Best-effort split of a "Name and address of donor" free-text field into
// street / city / state / postal. Address parsing is inherently lossy, so the
// whole raw string is always retained on the row; this only pulls out the parts
// we can identify with high confidence (postal code, 2-letter state) and treats
// the remainder as street.
export function parseAddress(v: unknown): {
  street: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  country: string | null;
} {
  const raw = s(v);
  if (!raw) return { street: null, city: null, state: null, postal: null, country: null };

  let working = raw;
  let postal: string | null = null;
  let state: string | null = null;
  let city: string | null = null;
  let country: string | null = null;

  // US / PR ZIP (5 digits, optional +4).
  const zip = working.match(/\b(\d{5}(?:-\d{4})?)\b/);
  if (zip) {
    postal = zip[1];
  }

  // "City, ST 00000" — capture the 2-letter state just before the ZIP.
  const cityState = working.match(/([A-Za-z.\s]+?),\s*([A-Za-z]{2})\b\s*\d{5}/);
  if (cityState && US_STATES.has(cityState[2].toUpperCase())) {
    city = cityState[1].trim().replace(/^[-–,\s]+/, "") || null;
    state = cityState[2].toUpperCase();
  } else {
    // "Dorado, PR 00646" without a preceding city token.
    const stOnly = working.match(/,\s*([A-Za-z]{2})\b\s*\d{5}/);
    if (stOnly && US_STATES.has(stOnly[1].toUpperCase())) state = stOnly[1].toUpperCase();
  }
  if (state === "PR") country = "USA";

  // Street = the slice before the city/state/zip tail, with a leading donor
  // name dropped if it's separated by " - " or "℅".
  let street = working;
  if (zip) street = working.slice(0, working.indexOf(zip[1])).trim();
  street = street.replace(/[,\s]+$/, "");
  if (city) {
    const cityIdx = street.lastIndexOf(city);
    if (cityIdx > 0) street = street.slice(0, cityIdx).replace(/[,\s]+$/, "");
  }
  // Drop a leading "Name- " / "Name ℅ " donor prefix when present.
  const dash = street.match(/^[^-]+[-–]\s*(.+)$/);
  if (dash && dash[1].length > 4) street = dash[1].trim();
  street = street.trim();

  return {
    street: street || null,
    city,
    state,
    postal,
    country,
  };
}

// ── Header-driven column mapping (FY24/FY25/FY26 Google Form exports) ────────

type ColMap = Record<string, number>;

const HEADER_MATCHERS: Record<string, (h: string) => boolean> = {
  timestamp: (h) => /timestamp/.test(h),
  email: (h) => /email/.test(h),
  partner: (h) => /person filling|filling out|wildflower partner/.test(h),
  donorName: (h) => /name of (the )?donor/.test(h) && !/address/.test(h),
  amount: (h) => /amount/.test(h),
  circle: (h) => /circle/.test(h),
  drive: (h) => /grant agreement|upload/.test(h),
  memo: (h) => /memo/.test(h),
  donorType: (h) => /type of donor/.test(h),
  series: (h) => /stand-alone|multi-?series/.test(h),
  additionalNotes: (h) => /additional notes/.test(h),
  restriction: (h) => /restrict/.test(h),
  nameAddress: (h) => /name and address/.test(h),
  report: (h) => /written report/.test(h),
  depositDate: (h) => /deposited|deposit date/.test(h),
  stripeFees: (h) => /fees charged/.test(h),
  class: (h) => /^class$/.test(h),
};

function buildColMap(headerRow: unknown[]): ColMap {
  const map: ColMap = {};
  headerRow.forEach((cell, idx) => {
    const h = s(cell)?.toLowerCase();
    if (!h) return;
    for (const [key, match] of Object.entries(HEADER_MATCHERS)) {
      if (map[key] === undefined && match(h)) map[key] = idx;
    }
  });
  return map;
}

// Per-source header-row index (junk rows above it). FY24 header is row 0; FY25
// has one junk row; FY26 has two.
const HEADER_ROW: Record<Exclude<CodingFormSource, "girasol">, number> = {
  fy24: 0,
  fy25: 1,
  fy26: 2,
};

export function parseFormSheet(
  source: Exclude<CodingFormSource, "girasol">,
  rows: unknown[][],
): ParsedCodingFormRow[] {
  const headerRowIdx = HEADER_ROW[source];
  const col = buildColMap(rows[headerRowIdx] ?? []);
  const out: ParsedCodingFormRow[] = [];

  const get = (row: unknown[], key: string): string | null =>
    col[key] === undefined ? null : s(row[col[key]]);

  let dataIdx = 0;
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const donorName = get(row, "donorName");
    // Skip blank + the "Test"/"Test" junk rows.
    if (!donorName) continue;
    if (donorName.toLowerCase() === "test") continue;

    const memo = get(row, "memo");
    const restriction = get(row, "restriction");
    const report = parseReport(get(row, "report"));
    const addr = parseAddress(get(row, "nameAddress"));

    const rawData: Record<string, unknown> = {};
    for (const [key, idx] of Object.entries(col)) rawData[key] = row[idx] ?? null;

    out.push({
      source,
      sourceRowIndex: dataIdx++,
      rawData,
      donorNameRaw: donorName,
      internalMemo: memo,
      donorTypeRaw: get(row, "donorType"),
      seriesTypeRaw: get(row, "series"),
      restrictionLanguage: restriction,
      donorNameAddressRaw: get(row, "nameAddress"),
      reportRequiredRaw: get(row, "report"),
      driveLink: get(row, "drive"),
      circleRaw: get(row, "circle"),
      additionalNotes: get(row, "additionalNotes"),
      paymentMethodRaw: null,
      stripeFeesRaw: get(row, "stripeFees"),
      classRaw: get(row, "class"),
      submitterEmail: get(row, "email"),
      wildflowerPartner: get(row, "partner"),
      amount: parseAmount(get(row, "amount")),
      donationDate: parseDate(get(row, "timestamp")),
      depositDate: parseDate(get(row, "depositDate")),
      addrStreet: addr.street,
      addrCity: addr.city,
      addrState: addr.state,
      addrPostal: addr.postal,
      addrCountry: addr.country,
      reportRequired: report.required,
      reportDueDate: report.dueDate,
      intendedUsageSuggested: suggestIntendedUsage(memo, restriction, get(row, "circle")),
    });
  }
  return out;
}

// Girasol / Act-60 sheet: header row 0, but several data columns are unlabeled.
// Fixed positional layout (verified against the export):
//   0 date · 1 donor · 2 amount · 3 hub/region · 4 drive link · 5 memo ·
//   6 payment method · 7 restriction · 8 name+address · 9 report notes
export function parseGirasolSheet(rows: unknown[][]): ParsedCodingFormRow[] {
  const out: ParsedCodingFormRow[] = [];
  let dataIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const donorName = s(row[1]);
    if (!donorName) continue;
    // Skip subtotal rows ("Total already issued from Wildflower", etc.).
    if (/^total\b/i.test(donorName)) continue;

    const memo = s(row[5]);
    const restriction = s(row[7]);
    const report = parseReport(s(row[9]));
    const addr = parseAddress(s(row[8]));
    const hub = s(row[3]);

    const rawData: Record<string, unknown> = {
      date: row[0] ?? null,
      donor: row[1] ?? null,
      amount: row[2] ?? null,
      hub: row[3] ?? null,
      driveLink: row[4] ?? null,
      memo: row[5] ?? null,
      paymentMethod: row[6] ?? null,
      restriction: row[7] ?? null,
      nameAddress: row[8] ?? null,
      reportNotes: row[9] ?? null,
    };

    out.push({
      source: "girasol",
      sourceRowIndex: dataIdx++,
      rawData,
      donorNameRaw: donorName,
      internalMemo: memo,
      donorTypeRaw: null,
      seriesTypeRaw: null,
      restrictionLanguage: restriction,
      donorNameAddressRaw: s(row[8]),
      reportRequiredRaw: s(row[9]),
      driveLink: s(row[4]),
      circleRaw: hub,
      additionalNotes: null,
      paymentMethodRaw: s(row[6]),
      stripeFeesRaw: null,
      classRaw: null,
      submitterEmail: null,
      wildflowerPartner: null,
      amount: parseAmount(row[2]),
      donationDate: parseDate(row[0]),
      depositDate: null,
      addrStreet: addr.street,
      addrCity: addr.city,
      addrState: addr.state,
      addrPostal: addr.postal,
      addrCountry: addr.country,
      reportRequired: report.required,
      reportDueDate: report.dueDate,
      intendedUsageSuggested: suggestIntendedUsage(memo, restriction, hub),
    });
  }
  return out;
}
