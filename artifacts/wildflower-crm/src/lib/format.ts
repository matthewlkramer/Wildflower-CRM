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
 * Match is case-insensitive; the abbreviated form is emitted as written.
 */
export function formatFunderNameShort(
  name: string | null | undefined,
): string {
  if (!name) return "";
  return name
    .replace(/\bFamily Foundation\b/gi, "F.F.")
    .replace(/\bFoundations\b/gi, "Fnds")
    .replace(/\bFoundation\b/gi, "Fnd")
    .replace(/\bFundación\b/gi, "Fnd")
    .replace(/\bDepartment\b/gi, "Dept")
    .replace(/\bEducation\b/gi, "Educ");
}
