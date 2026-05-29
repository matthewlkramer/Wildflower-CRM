import { clerkClient } from "@clerk/express";

/**
 * Minimal shape of the Clerk backend user object we depend on. Declared
 * locally so the resolver can be unit-tested with a stub instead of the
 * real Clerk SDK.
 */
export interface ClerkUserLike {
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
}

/** Fetches a Clerk user by id. Injectable for testing. */
export type ClerkUserFetcher = (clerkId: string) => Promise<ClerkUserLike>;

/**
 * Extracts the best email for a Clerk user: the primary email address when
 * one is designated, otherwise the first available address. Returns
 * undefined (lowercased when present) if the user has no email at all.
 */
export function pickClerkEmail(user: ClerkUserLike): string | undefined {
  const addrs = user.emailAddresses ?? [];
  if (addrs.length === 0) return undefined;
  const primary =
    (user.primaryEmailAddressId &&
      addrs.find((a) => a.id === user.primaryEmailAddressId)) ||
    addrs[0];
  return primary?.emailAddress?.toLowerCase();
}

/**
 * Resolve a signed-in user's email.
 *
 * Clerk does NOT include `email` in session claims by default, so
 * `sessionClaims?.email` is almost always undefined for real sign-ins.
 * When the claim is missing we fall back to a Clerk backend lookup by id
 * and read the primary email address. This is what lets the auth
 * middleware adopt a pre-seeded team-member row instead of provisioning a
 * blank `@unknown.com` account.
 */
export async function resolveClerkEmail(
  clerkId: string,
  claimEmail: string | undefined,
  fetcher: ClerkUserFetcher = (id) => clerkClient.users.getUser(id),
): Promise<string | undefined> {
  if (claimEmail) return claimEmail.toLowerCase();
  try {
    const user = await fetcher(clerkId);
    return pickClerkEmail(user);
  } catch {
    return undefined;
  }
}
