import { clerkClient } from "@clerk/express";

export type ClerkIdentity = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
};

/**
 * Resolve a user's real identity straight from the Clerk backend by Clerk
 * user id. Used when the session token has no `email` claim (so provisioning
 * doesn't fall back to a `<clerkId>@unknown.com` placeholder with blank
 * names) and by the one-off identity backfill script.
 *
 * Returns null on any Clerk lookup failure so callers can fall back to a
 * placeholder / archive instead of throwing during the auth path.
 */
export async function fetchClerkIdentity(
  clerkId: string,
): Promise<ClerkIdentity | null> {
  try {
    const cu = await clerkClient.users.getUser(clerkId);
    const primaryId = cu.primaryEmailAddressId;
    const email =
      cu.emailAddresses.find((e) => e.id === primaryId)?.emailAddress ??
      cu.emailAddresses[0]?.emailAddress ??
      null;
    const firstName = cu.firstName?.trim() || null;
    const lastName = cu.lastName?.trim() || null;
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const displayName = cu.fullName?.trim() || fullName || null;
    return {
      email: email?.trim() || null,
      firstName,
      lastName,
      displayName,
    };
  } catch {
    return null;
  }
}
