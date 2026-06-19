import { organizations, people, households } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { maskName, type Viewer } from "./identityVisibility";

// Shared "donor join" projection for the two money headers
// (opportunities_and_pledges and gifts_and_payments). Both carry the Donor XOR
// (organization / household / individual giver), so both lists/details
// denormalize the SAME donor display names + priority tiers, plus the
// anonymous/owner helper aliases used for server-side masking. Spread
// `donorDisplayColumns` into each route's own select alongside its
// route-specific aggregates; run rows through `maskDonorDisplayFields` before
// res.json to mask anonymous names and strip the helper aliases.
//
// Households are NEVER anonymizable (only organizations + people), so
// `householdName` carries no helper and is never masked.
export const donorDisplayColumns = {
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
  // Denormalized priority tier so the donor cell can render a star (priority
  // === 'top') without an extra fetch. NULL when that donor slot isn't set.
  organizationPriority: organizations.priority,
  individualGiverPersonPriority: people.priority,
  // Anonymous-masking helpers: carry each anonymizable join's anonymous + owner
  // so the consumer can mask the denormalized donor display names server-side.
  // Explicit aliases avoid colliding with the spread header columns; they are
  // stripped before res.json by maskDonorDisplayFields so the response shape is
  // unchanged.
  organizationAnonymous: organizations.anonymous,
  organizationOwnerUserId: organizations.ownerUserId,
  individualGiverAnonymous: people.anonymous,
  individualGiverOwnerUserId: people.ownerUserId,
};

// The subset of a donorJoinSelect row that maskDonorDisplayFields consumes.
export interface DonorDisplayHelperFields {
  organizationName: string | null;
  individualGiverPersonName: string | null;
  organizationAnonymous: boolean | null;
  organizationOwnerUserId: string | null;
  individualGiverAnonymous: boolean | null;
  individualGiverOwnerUserId: string | null;
}

type StripDonorHelpers<T> = Omit<
  T,
  | "organizationAnonymous"
  | "organizationOwnerUserId"
  | "individualGiverAnonymous"
  | "individualGiverOwnerUserId"
>;

// Mask the shared donor display names (organization + individual giver) and
// strip the anonymous/owner helper aliases. Returns the row WITHOUT the helper
// fields, with masked names overlaid — so the JSON response shape is unchanged.
// Route-specific extras (e.g. the opportunities primary contact) are layered by
// the caller on top of the returned object.
export function maskDonorDisplayFields<T extends DonorDisplayHelperFields>(
  row: T,
  viewer: Viewer,
): StripDonorHelpers<T> {
  const {
    organizationAnonymous,
    organizationOwnerUserId,
    individualGiverAnonymous,
    individualGiverOwnerUserId,
    ...rest
  } = row;
  return {
    ...rest,
    organizationName: maskName(
      rest.organizationName,
      { anonymous: organizationAnonymous, ownerUserId: organizationOwnerUserId },
      viewer,
    ),
    individualGiverPersonName: maskName(
      rest.individualGiverPersonName,
      {
        anonymous: individualGiverAnonymous,
        ownerUserId: individualGiverOwnerUserId,
      },
      viewer,
    ),
  } as StripDonorHelpers<T>;
}
