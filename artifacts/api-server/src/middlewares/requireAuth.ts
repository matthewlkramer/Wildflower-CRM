import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { db } from "@workspace/db";
import { users, type User } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { setAppUser } from "../lib/appRequest";
import { fetchClerkIdentity, type ClerkIdentity } from "../lib/clerkIdentity";

/**
 * Minimal persistence surface the auth resolver needs. Declared here so the
 * branch logic (find-by-clerkId → adopt-seeded-row-by-email → provision-new)
 * can be unit-tested against a fake instead of the real Drizzle/Postgres db.
 */
export interface UserRepo {
  findByClerkId(clerkId: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  /**
   * Claim a pre-seeded row by stamping it with the Clerk id, filling in any
   * missing identity fields (name) from Clerk without clobbering existing ones.
   */
  adoptByEmail(
    existing: User,
    clerkId: string,
    identity: ClerkIdentity | null,
  ): Promise<User>;
  /**
   * Idempotently provision a new user for this clerkId, seeding name fields
   * from Clerk when available. Must be ON CONFLICT (clerk_id) safe so
   * concurrent first-login requests all resolve to the same row.
   */
  provision(
    clerkId: string,
    email: string,
    identity: ClerkIdentity | null,
  ): Promise<User>;
}

/** Resolves a user's real identity from Clerk. Injectable for testing. */
export type ClerkIdentityFetcher = (
  clerkId: string,
) => Promise<ClerkIdentity | null>;

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403 | 500; error: string };

/**
 * Resolve the application user for an authenticated Clerk session.
 *
 * Branch order:
 *   1. find by clerkId (returning user) — fast path.
 *   2. otherwise resolve the email (claim or Clerk backend lookup) and adopt
 *      a pre-seeded row with the same email by stamping its clerkId.
 *   3. otherwise provision a fresh row (idempotent on clerkId).
 *
 * The Clerk backend lookup also yields the real name, so adoption and
 * provisioning fill in firstName/lastName/displayName instead of leaving
 * nameless placeholders that pollute owner pickers.
 *
 * Archived users are denied (403) both when adopting a seeded row and after
 * the final resolution, so an archived placeholder can never be resurrected
 * by signing in.
 */
export async function resolveAuthenticatedUser(
  clerkId: string,
  claimEmail: string | undefined,
  repo: UserRepo,
  identityFetcher: ClerkIdentityFetcher = fetchClerkIdentity,
): Promise<AuthResult> {
  let user = await repo.findByClerkId(clerkId);

  if (!user) {
    // Clerk does not put `email` in session claims by default, so claimEmail
    // is almost always undefined. We fetch the real identity (email + name)
    // from the Clerk backend so the seeded-row adoption branch can actually
    // fire for real sign-ins and so provisioning doesn't fall back to a
    // nameless `<clerkId>@unknown.com` row that owns nothing.
    const normalizedClaim = claimEmail?.trim() || undefined;
    const identity = await identityFetcher(clerkId);
    const email = normalizedClaim ?? identity?.email ?? undefined;

    // First-login adoption: if a pre-seeded user row exists with the same
    // email, claim it by updating its clerkId rather than inserting a
    // duplicate. BUT do not silently resurrect an archived user — signing
    // back in should be denied (403) so an operator has to explicitly
    // unarchive, otherwise archive is meaningless as access control.
    if (email) {
      const existing = await repo.findByEmail(email);
      if (existing) {
        if (existing.archivedAt) {
          return { ok: false, status: 403, error: "user_archived" };
        }
        user = await repo.adoptByEmail(existing, clerkId, identity);
      }
    }

    if (!user) {
      // First-login provisioning. The frontend fires multiple parallel API
      // requests on first page load, so several requireAuth invocations race
      // here for the same Clerk userId. provision() must be idempotent on
      // conflict so all concurrent first-login requests resolve to the same
      // user row.
      user = await repo.provision(
        clerkId,
        email ?? `${clerkId}@unknown.com`,
        identity,
      );
    }
  }

  if (!user) {
    return { ok: false, status: 500, error: "user_provision_failed" };
  }

  // Deny archived users at the auth boundary. The Google SSO restriction to
  // @wildflowerschools.org is the primary access gate, but archive is
  // defense-in-depth: an admin can immediately revoke a team member's access
  // without waiting on Google Workspace propagation, and it also blocks any
  // pre-seeded placeholder rows that were archived before being claimed.
  if (user.archivedAt) {
    return { ok: false, status: 403, error: "user_archived" };
  }

  return { ok: true, user };
}

/** Real Drizzle/Postgres-backed implementation of {@link UserRepo}. */
const dbUserRepo: UserRepo = {
  findByClerkId: (clerkId) =>
    db
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .then((rows) => rows[0]),
  findByEmail: (email) =>
    db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .then((rows) => rows[0]),
  adoptByEmail: (existing, clerkId, identity) =>
    db
      .update(users)
      .set({
        clerkId,
        // Fill in any missing identity fields from Clerk, but don't clobber
        // a name the row already has.
        firstName: existing.firstName ?? identity?.firstName ?? null,
        lastName: existing.lastName ?? identity?.lastName ?? null,
        displayName: existing.displayName ?? identity?.displayName ?? null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning()
      .then((rows) => rows[0]),
  provision: (clerkId, email, identity) =>
    db
      .insert(users)
      .values({
        id: nanoid(),
        clerkId,
        email,
        firstName: identity?.firstName ?? null,
        lastName: identity?.lastName ?? null,
        displayName: identity?.displayName ?? null,
        role: "team_member",
      })
      .onConflictDoUpdate({
        target: users.clerkId,
        set: { updatedAt: new Date() },
      })
      .returning()
      .then((rows) => rows[0]),
};

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const claimEmail = auth.sessionClaims?.email as string | undefined;
    const result = await resolveAuthenticatedUser(
      auth.userId,
      claimEmail,
      dbUserRepo,
    );

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    setAppUser(req, result.user);
    next();
  } catch (err) {
    next(err);
  }
};
