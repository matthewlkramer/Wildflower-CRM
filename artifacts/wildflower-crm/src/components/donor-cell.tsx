import { Link } from "wouter";
import { formatFunderNameShort } from "@/lib/format";
import { PriorityStar } from "@/components/priority-star";

type Props = {
  funderId?: string | null;
  funderName?: string | null;
  funderIsPriority?: boolean | null;
  householdId?: string | null;
  householdName?: string | null;
  individualGiverPersonId?: string | null;
  individualGiverPersonName?: string | null;
  individualGiverPersonIsPriority?: boolean | null;
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
  funderId,
  funderName,
  funderIsPriority,
  householdId,
  householdName,
  individualGiverPersonId,
  individualGiverPersonName,
  individualGiverPersonIsPriority,
}: Props) {
  if (funderId) {
    return (
      <span className="inline-flex items-center gap-1">
        <PriorityStar kind="funder" id={funderId} isPriority={funderIsPriority} readOnly size="sm" />
        <Link
          href={`/funding-entities/${funderId}`}
          className="hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {funderName ? formatFunderNameShort(funderName) : funderId}
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
        <PriorityStar
          kind="person"
          id={individualGiverPersonId}
          isPriority={individualGiverPersonIsPriority}
          readOnly
          size="sm"
        />
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
