import { Link } from "wouter";
import type { Priority } from "@workspace/api-client-react";
import { formatOrganizationNameShort } from "@/lib/format";
import { PriorityStar } from "@/components/priority-star";

type Props = {
  organizationId?: string | null;
  organizationName?: string | null;
  organizationPriority?: Priority | null;
  householdId?: string | null;
  householdName?: string | null;
  individualGiverPersonId?: string | null;
  individualGiverPersonName?: string | null;
  individualGiverPersonPriority?: Priority | null;
};

/**
 * Renders the donor for an opportunity or gift row. Per the
 * `*_donor_xor` CHECK constraints, exactly one of the three IDs is set
 * per row. The matching display name is denormalized server-side onto
 * the list + detail responses so the UI doesn't have to fire one fetch
 * per row to resolve donor IDs. Each name falls back to its ID if the
 * server didn't return one (e.g. the parent row was deleted).
 */
export function DonorCell({
  organizationId,
  organizationName,
  organizationPriority,
  householdId,
  householdName,
  individualGiverPersonId,
  individualGiverPersonName,
  individualGiverPersonPriority,
}: Props) {
  if (organizationId) {
    return (
      <span className="inline-flex items-center gap-1">
        <PriorityStar priority={organizationPriority} size="sm" />
        <Link
          href={`/organizations/${organizationId}`}
          className="hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {organizationName ? formatOrganizationNameShort(organizationName) : organizationId}
        </Link>
      </span>
    );
  }
  if (householdId) {
    return (
      <Link
        href={`/households/${householdId}`}
        className="hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {householdName ?? householdId}
      </Link>
    );
  }
  if (individualGiverPersonId) {
    return (
      <span className="inline-flex items-center gap-1">
        <PriorityStar priority={individualGiverPersonPriority} size="sm" />
        <Link
          href={`/individuals/${individualGiverPersonId}`}
          className="hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {individualGiverPersonName ?? individualGiverPersonId}
        </Link>
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}
