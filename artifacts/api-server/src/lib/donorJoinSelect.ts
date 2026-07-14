import { organizations, people, households } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { maskName, type Viewer } from "./identityVisibility";

export const donorDisplayColumns = {
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
  organizationPriority: organizations.priority,
  individualGiverPersonPriority: people.priority,
  organizationAnonymous: organizations.anonymous,
  organizationOwnerUserId: organizations.ownerUserId,
  individualGiverAnonymous: people.anonymous,
  individualGiverOwnerUserId: people.ownerUserId,
};

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
  | "matchedGiftId"
  | "createdGiftId"
>;

/**
 * Mask donor display names and remove server-only fields before JSON responses.
 *
 * During the ledger-first cutover this is also the final response boundary for
 * Donorbox review rows, so deprecated matched_gift_id / created_gift_id columns
 * are stripped even when a broad table projection selected them. Clients receive
 * only the ledger-derived linkedGiftId relationship.
 */
export function maskDonorDisplayFields<T extends DonorDisplayHelperFields>(
  row: T,
  viewer: Viewer,
): StripDonorHelpers<T> {
  const {
    organizationAnonymous,
    organizationOwnerUserId,
    individualGiverAnonymous,
    individualGiverOwnerUserId,
    matchedGiftId: _matchedGiftId,
    createdGiftId: _createdGiftId,
    ...rest
  } = row as T & {
    matchedGiftId?: unknown;
    createdGiftId?: unknown;
  };

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
