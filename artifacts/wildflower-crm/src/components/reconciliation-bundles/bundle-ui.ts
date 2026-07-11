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
