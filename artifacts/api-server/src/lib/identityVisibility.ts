import type { Request } from "express";
import { getAppUser } from "./appRequest";

// Server-side anonymous-name masking.
//
// Mirrors the UI's `canSeeIdentity` (artifacts/wildflower-crm/src/lib/visibility.ts):
// an anonymous organization/person's real name is only visible to the record
// owner and admins. Anonymity began as a UI-only courtesy, so denormalized
// join/aggregate projections (donor display names, affiliated people, primary
// contacts, active/past organization names, …) still leaked the real name to
// every viewer. These helpers are applied to those projections so the API
// stops emitting anonymous names to viewers who aren't the owner or an admin.
//
// Only ORGANIZATIONS and PEOPLE can be anonymous — HOUSEHOLDS are never masked.

export const ANON_LABEL = "Anonymous";

export interface Viewer {
  id: string;
  role: string;
}

export interface Anonymizable {
  anonymous: boolean | null;
  ownerUserId: string | null;
}

/** Build the identity-visibility viewer from the authenticated request. */
export function getViewer(req: Request): Viewer {
  const u = getAppUser(req);
  return { id: u?.id ?? "", role: u?.role ?? "" };
}

/**
 * Whether `viewer` may see the real name of `entity`. Non-anonymous records are
 * always visible; otherwise only admins and the record owner can see them.
 */
export function canSeeIdentity(entity: Anonymizable, viewer: Viewer): boolean {
  if (!entity.anonymous) return true;
  if (viewer.role === "admin") return true;
  return viewer.id === entity.ownerUserId;
}

/**
 * Replace a display name with ANON_LABEL when the viewer can't see the entity's
 * identity. Returns the name unchanged when visible (may be null); returns
 * ANON_LABEL when hidden, even if the underlying name was null.
 */
export function maskName(
  name: string | null,
  entity: Anonymizable,
  viewer: Viewer,
): string | null {
  return canSeeIdentity(entity, viewer) ? name : ANON_LABEL;
}
