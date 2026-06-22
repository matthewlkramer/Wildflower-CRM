import { donorboxDonations } from "@workspace/db/schema";

/**
 * The read-only Donorbox columns surfaced as enrichment on a Stripe-sourced
 * record (charge or gift). The raw payload, questions, and review/donor-match
 * state are deliberately excluded — enrichment is display-only and must never
 * leak the verbatim Donorbox payload into list/detail responses.
 *
 * Used as a drizzle nested-select object so a single LEFT/INNER JOIN against
 * donorbox_donations (1:1 by stripe_charge_id) yields a `donorbox` sub-object.
 */
export const donorboxEnrichmentSelect = {
  id: donorboxDonations.id,
  donationType: donorboxDonations.donationType,
  amount: donorboxDonations.amount,
  processingFee: donorboxDonations.processingFee,
  currency: donorboxDonations.currency,
  donatedAt: donorboxDonations.donatedAt,
  campaignName: donorboxDonations.campaignName,
  designation: donorboxDonations.designation,
  comment: donorboxDonations.comment,
  recurring: donorboxDonations.recurring,
  refunded: donorboxDonations.refunded,
  anonymous: donorboxDonations.anonymous,
  donorName: donorboxDonations.donorName,
  donorEmail: donorboxDonations.donorEmail,
  donorEmployer: donorboxDonations.donorEmployer,
} as const;

/** The shape produced by selecting {@link donorboxEnrichmentSelect} over a
 * (possibly missing) LEFT JOIN — every column is nullable. */
export interface DonorboxEnrichmentRow {
  id: string | null;
  donationType: string | null;
  amount: string | null;
  processingFee: string | null;
  currency: string | null;
  donatedAt: Date | null;
  campaignName: string | null;
  designation: string | null;
  comment: string | null;
  recurring: boolean | null;
  refunded: boolean | null;
  anonymous: boolean | null;
  donorName: string | null;
  donorEmail: string | null;
  donorEmployer: string | null;
}

/** The normalized enrichment object returned on the API (matches the
 * `DonorboxEnrichment` OpenAPI schema). */
export interface DonorboxEnrichment {
  id: string;
  donationType: string | null;
  amount: string | null;
  processingFee: string | null;
  currency: string | null;
  donatedAt: Date | null;
  campaignName: string | null;
  designation: string | null;
  comment: string | null;
  recurring: boolean;
  refunded: boolean;
  anonymous: boolean;
  donorName: string | null;
  donorEmail: string | null;
  donorEmployer: string | null;
}

/**
 * Collapse a joined Donorbox enrichment row to `null` when there is no matching
 * donation (a LEFT JOIN miss leaves every column null). Otherwise return a
 * fully-typed enrichment object, applying the NOT-NULL boolean defaults the
 * column definitions guarantee.
 */
export function donorboxEnrichmentOrNull(
  row: DonorboxEnrichmentRow | null | undefined,
): DonorboxEnrichment | null {
  if (!row || row.id == null) return null;
  return {
    id: row.id,
    donationType: row.donationType,
    amount: row.amount,
    processingFee: row.processingFee,
    currency: row.currency,
    donatedAt: row.donatedAt,
    campaignName: row.campaignName,
    designation: row.designation,
    comment: row.comment,
    recurring: row.recurring ?? false,
    refunded: row.refunded ?? false,
    anonymous: row.anonymous ?? false,
    donorName: row.donorName,
    donorEmail: row.donorEmail,
    donorEmployer: row.donorEmployer,
  };
}
