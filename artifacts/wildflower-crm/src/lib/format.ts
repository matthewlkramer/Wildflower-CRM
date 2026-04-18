import { format, parseISO } from "date-fns";

export function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  try {
    return format(parseISO(dateString), "MMM d, yyyy");
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
