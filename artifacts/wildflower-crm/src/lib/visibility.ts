import type { Funder, Person } from "@workspace/api-client-react";
import { personDisplayName } from "@/lib/person";

/**
 * The current viewer, as returned by `useGetCurrentUser()` (`GET /users/me`).
 * Only `id` and `role` matter for identity-visibility decisions.
 */
export type Viewer = { id?: string | null; role?: string | null } | null | undefined;

export const ANONYMOUS_LABEL = "Anonymous";

/**
 * Whether `viewer` is allowed to see the real name of an anonymous record.
 *
 * This is a UI-only courtesy: anonymity is NOT enforced server-side, so the
 * real name is still present in API responses. We hide it in the UI from
 * everyone except the record's owner and admins.
 */
export function canSeeIdentity(
  entity: { anonymous?: boolean | null; ownerUserId?: string | null },
  viewer: Viewer,
): boolean {
  if (!entity.anonymous) return true;
  if (!viewer) return false;
  if (viewer.role === "admin") return true;
  return !!viewer.id && viewer.id === entity.ownerUserId;
}

/**
 * Whether `viewer` is allowed to manage (toggle) a record's anonymity. Unlike
 * `canSeeIdentity`, this does NOT depend on the current `anonymous` value — only
 * the owner and admins may flip the flag, so a non-owner can't mark someone
 * anonymous (or un-anonymize a record they don't own).
 */
export function canManageIdentity(
  entity: { ownerUserId?: string | null },
  viewer: Viewer,
): boolean {
  if (!viewer) return false;
  if (viewer.role === "admin") return true;
  return !!viewer.id && viewer.id === entity.ownerUserId;
}

export function displayFunderName(
  funder: Pick<Funder, "name" | "anonymous" | "ownerUserId">,
  viewer: Viewer,
): string {
  return canSeeIdentity(funder, viewer) ? funder.name : ANONYMOUS_LABEL;
}

export function displayPersonName(
  person: Pick<
    Person,
    "fullName" | "firstName" | "lastName" | "nickname" | "id" | "anonymous" | "ownerUserId"
  >,
  viewer: Viewer,
): string {
  return canSeeIdentity(person, viewer) ? personDisplayName(person) : ANONYMOUS_LABEL;
}
