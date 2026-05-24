import { Link } from "wouter";

type Props = {
  funderId?: string | null;
  funderName?: string | null;
  householdId?: string | null;
  householdName?: string | null;
  individualGiverPersonId?: string | null;
  individualGiverPersonName?: string | null;
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
  householdId,
  householdName,
  individualGiverPersonId,
  individualGiverPersonName,
}: Props) {
  if (funderId) {
    return (
      <Link
        href={`/funding-entities/${funderId}`}
        className="hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {funderName ?? funderId}
      </Link>
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
      <Link
        href={`/individuals/${individualGiverPersonId}`}
        className="hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {individualGiverPersonName ?? individualGiverPersonId}
      </Link>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}
