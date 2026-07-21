import type { OpportunityStatus } from "@workspace/api-client-react";

/**
 * Canonical display labels for the server-derived opportunity status.
 * `pledge` is stored as-is but surfaced to fundraisers as
 * "Waiting for payment". Every surface that renders an opportunity
 * status (badges, list cells, filter options, picker rows) must route
 * through this map so the same fact never reads differently per page.
 */
export const OPPORTUNITY_STATUS_LABEL: Record<OpportunityStatus, string> = {
  open: "Open",
  pledge: "Waiting for payment",
  cash_in: "Cash in",
  dormant: "Dormant",
  lost: "Lost",
};

/**
 * Label helper tolerant of null/undefined and unrecognized values
 * (falls back to the raw value so a new enum member is never hidden).
 */
export function opportunityStatusLabel(
  status: string | null | undefined,
): string | null {
  if (!status) return null;
  return (
    OPPORTUNITY_STATUS_LABEL[status as OpportunityStatus] ?? status
  );
}
