import { describe, it, expect } from "vitest";
import {
  resolveAuthenticatedUser,
  type UserRepo,
} from "../middlewares/requireAuth";
import type { ClerkIdentity } from "../lib/clerkIdentity";
import type { User } from "@workspace/db/schema";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u_seed",
    clerkId: "clerk_seed",
    email: "person@wildflowerschools.org",
    firstName: null,
    lastName: null,
    displayName: null,
    role: "team_member",
    defaultFund: null,
    emailSyncMode: "full",
    extensionToken: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * In-memory UserRepo backed by a list of seeded rows. Records every call so
 * tests can assert which branch fired (adopt vs provision) and applies the
 * same name-filling semantics as the real Drizzle repo.
 */
function makeRepo(seed: User[] = []) {
  const rows = [...seed];
  const calls = {
    findByClerkId: 0,
    findByEmail: 0,
    adoptByEmail: 0,
    provision: 0,
  };
  const repo: UserRepo = {
    async findByClerkId(clerkId) {
      calls.findByClerkId++;
      return rows.find((r) => r.clerkId === clerkId);
    },
    async findByEmail(email) {
      calls.findByEmail++;
      return rows.find((r) => r.email === email);
    },
    async adoptByEmail(existing, clerkId, identity) {
      calls.adoptByEmail++;
      const row = rows.find((r) => r.id === existing.id);
      if (!row) throw new Error("row not found");
      row.clerkId = clerkId;
      row.firstName = row.firstName ?? identity?.firstName ?? null;
      row.lastName = row.lastName ?? identity?.lastName ?? null;
      row.displayName = row.displayName ?? identity?.displayName ?? null;
      row.updatedAt = new Date();
      return row;
    },
    async provision(clerkId, email, identity) {
      calls.provision++;
      const created = makeUser({
        id: `prov_${clerkId}`,
        clerkId,
        email,
        firstName: identity?.firstName ?? null,
        lastName: identity?.lastName ?? null,
        displayName: identity?.displayName ?? null,
      });
      rows.push(created);
      return created;
    },
  };
  return { repo, calls, rows };
}

/** Stub Clerk identity fetcher returning the given email + optional name. */
function identityFetcherFor(
  email: string,
  name?: { firstName?: string; lastName?: string; displayName?: string },
) {
  return async (): Promise<ClerkIdentity> => ({
    email,
    firstName: name?.firstName ?? null,
    lastName: name?.lastName ?? null,
    displayName: name?.displayName ?? null,
  });
}

describe("resolveAuthenticatedUser", () => {
  it("returns the existing row by clerkId without touching email branches", async () => {
    const existing = makeUser({ id: "u1", clerkId: "clerk_known" });
    const { repo, calls } = makeRepo([existing]);

    const result = await resolveAuthenticatedUser(
      "clerk_known",
      undefined,
      repo,
      identityFetcherFor("should.not.be.used@wildflowerschools.org"),
    );

    expect(result).toEqual({ ok: true, user: existing });
    expect(calls.findByEmail).toBe(0);
    expect(calls.adoptByEmail).toBe(0);
    expect(calls.provision).toBe(0);
  });

  it("adopts a seeded row when the resolved email matches (Clerk lookup stubbed)", async () => {
    const seeded = makeUser({
      id: "u_seed",
      clerkId: "placeholder_clerk_id",
      email: "erica.cantoni@wildflowerschools.org",
    });
    const { repo, calls, rows } = makeRepo([seeded]);

    const result = await resolveAuthenticatedUser(
      "clerk_new_session",
      undefined, // no claim email → forces the Clerk backend lookup
      repo,
      identityFetcherFor("erica.cantoni@wildflowerschools.org", {
        firstName: "Erica",
        lastName: "Cantoni",
        displayName: "Erica Cantoni",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe("u_seed");
      expect(result.user.clerkId).toBe("clerk_new_session");
      // Name was backfilled from Clerk during adoption.
      expect(result.user.displayName).toBe("Erica Cantoni");
    }
    expect(calls.adoptByEmail).toBe(1);
    expect(calls.provision).toBe(0);
    // The seeded row was claimed, not duplicated.
    expect(rows.length).toBe(1);
  });

  it("provisions a fresh row (with name) when no seeded email matches", async () => {
    const { repo, calls, rows } = makeRepo([]);

    const result = await resolveAuthenticatedUser(
      "clerk_brand_new",
      undefined,
      repo,
      identityFetcherFor("newhire@wildflowerschools.org", {
        firstName: "New",
        lastName: "Hire",
        displayName: "New Hire",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.clerkId).toBe("clerk_brand_new");
      expect(result.user.email).toBe("newhire@wildflowerschools.org");
      expect(result.user.displayName).toBe("New Hire");
    }
    expect(calls.adoptByEmail).toBe(0);
    expect(calls.provision).toBe(1);
    expect(rows.length).toBe(1);
  });

  it("provisions an @unknown.com row when the identity can't be resolved", async () => {
    const { repo, calls } = makeRepo([]);

    const result = await resolveAuthenticatedUser(
      "clerk_no_email",
      undefined,
      repo,
      async () => null, // Clerk lookup failed
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.email).toBe("clerk_no_email@unknown.com");
      expect(result.user.displayName).toBeNull();
    }
    expect(calls.adoptByEmail).toBe(0);
    expect(calls.provision).toBe(1);
  });

  it("denies an archived seeded row with 403 instead of adopting it", async () => {
    const archived = makeUser({
      id: "u_archived",
      clerkId: "old_clerk",
      email: "retired@wildflowerschools.org",
      archivedAt: new Date("2026-02-01T00:00:00Z"),
    });
    const { repo, calls } = makeRepo([archived]);

    const result = await resolveAuthenticatedUser(
      "clerk_resurrect_attempt",
      undefined,
      repo,
      identityFetcherFor("retired@wildflowerschools.org"),
    );

    expect(result).toEqual({ ok: false, status: 403, error: "user_archived" });
    expect(calls.adoptByEmail).toBe(0);
    expect(calls.provision).toBe(0);
  });

  it("denies an archived returning user (found by clerkId) with 403", async () => {
    const archived = makeUser({
      id: "u_archived",
      clerkId: "clerk_archived",
      archivedAt: new Date("2026-02-01T00:00:00Z"),
    });
    const { repo } = makeRepo([archived]);

    const result = await resolveAuthenticatedUser(
      "clerk_archived",
      undefined,
      repo,
    );

    expect(result).toEqual({ ok: false, status: 403, error: "user_archived" });
  });

  it("uses the session-claim email and skips the Clerk backend lookup for email", async () => {
    const seeded = makeUser({
      id: "u_seed",
      clerkId: "placeholder",
      email: "claimed@wildflowerschools.org",
    });
    const { repo, calls } = makeRepo([seeded]);

    const result = await resolveAuthenticatedUser(
      "clerk_with_claim",
      "claimed@wildflowerschools.org",
      repo,
      identityFetcherFor("different@wildflowerschools.org"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.id).toBe("u_seed");
    expect(calls.adoptByEmail).toBe(1);
  });
});
