// Shared helpers + label maps for the settlement-bundle reconciliation UI.
import type {
  BundleDonorProposalDonorKind,
  BundleRowOverrideDonorRecordKind,
  BundleWarningSeverity,
} from "@workspace/api-client-react";
import type { DonorType } from "@/components/entity-picker";

/** Donor record kind on the wire ("person") ↔ picker DonorType ("individual"). */
export function recordKindToDonorType(
  kind: BundleDonorProposalDonorKind | BundleRowOverrideDonorRecordKind,
): DonorType {
  if (kind === "person") return "individual";
  if (kind === "household") return "household";
  return "organization";
}

export function donorTypeToRecordKind(
  type: DonorType,
): BundleRowOverrideDonorRecordKind {
  if (type === "individual") return "person";
  if (type === "household") return "household";
  return "organization";
}

export const CONFIDENCE_TIER_LABEL: Record<BundleConfidenceTier, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No match",
};

/** Tailwind classes for a confidence-tier chip. */
export function confidenceTierClass(tier: BundleConfidenceTier): string {
  switch (tier) {
    case "high":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "medium":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "low":
      return "bg-orange-100 text-orange-800 border-orange-200";
    case "none":
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

/** Tailwind classes for a warning chip, keyed by severity. */
export function warningSeverityClass(severity: BundleWarningSeverity): string {
  switch (severity) {
    case "blocker":
      return "bg-destructive/10 text-destructive border-destructive/30";
    case "warning":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "info":
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

/** A short payout / staged-payment id for compact display (po_abc…1234). */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
