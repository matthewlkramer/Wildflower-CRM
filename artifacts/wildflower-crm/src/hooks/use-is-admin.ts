import { useGetCurrentUser } from "@workspace/api-client-react";

/**
 * True when the signed-in user has the admin role. Admin-only affordances —
 * viewing archived rows ("Show archived") and unarchiving — gate on this.
 * The server enforces the same rule independently; this only controls the UI.
 */
export function useIsAdmin(): boolean {
  return useGetCurrentUser().data?.role === "admin";
}
