import { beforeEach, describe, expect, it, vi } from "vitest";
import { emails, organizations, personSuppressionWindows } from "@workspace/db/schema";

// Mutable fake-DB state shared with the hoisted vi.mock factory below.
const state = vi.hoisted(() => ({
  emailsRows: [] as Array<{
    personId: string | null;
    organizationId: string | null;
    householdId: string | null;
  }>,
  orgRows: [] as Array<{ organizationId: string }>,
  suppressionRows: [] as Array<{ personId: string }>,
  // Records whether the organizations.email_domain query actually ran.
  // The matcher short-circuits (never touches the DB) when no non-free
  // domains survive filtering, so this flag proves a free domain never
  // reaches the domain-match branch.
  orgQueried: false,
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === emails) return Promise.resolve(state.emailsRows);
          if (table === organizations) {
            state.orgQueried = true;
            return Promise.resolve(state.orgRows);
          }
          if (table === personSuppressionWindows) {
            return Promise.resolve(state.suppressionRows);
          }
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

// Imported after the mock is declared (vi.mock is hoisted regardless).
import { matchEmails } from "../lib/emailMatcher";

beforeEach(() => {
  state.emailsRows = [];
  state.orgRows = [];
  state.suppressionRows = [];
  state.orgQueried = false;
});

describe("matchEmails — free-mail domains never match a whole org", () => {
  it("does NOT match an org by domain when a free domain is stored in email_domain", async () => {
    // Simulate an org that mistakenly has gmail.com in email_domain: it would
    // be returned IF the domain branch ever queried for it.
    state.orgRows = [{ organizationId: "org-free" }];

    const result = await matchEmails(["someone@gmail.com"], null);

    expect(result.organizationIds).toEqual([]);
    // The org domain query must never have run — gmail.com was filtered out
    // before building the domain set.
    expect(state.orgQueried).toBe(false);
  });

  it("still matches an org by a real (non-free) domain", async () => {
    // Control: proves the domain-match branch itself is intact and that
    // only free domains are excluded.
    state.orgRows = [{ organizationId: "org-real" }];

    const result = await matchEmails(["officer@realfunder.org"], null);

    expect(result.organizationIds).toEqual(["org-real"]);
    expect(state.orgQueried).toBe(true);
  });

  it("drops the free domain but still uses a real domain in a mixed set", async () => {
    state.orgRows = [{ organizationId: "org-real" }];

    const result = await matchEmails(
      ["donor@yahoo.com", "officer@realfunder.org"],
      null,
    );

    expect(result.organizationIds).toEqual(["org-real"]);
    expect(state.orgQueried).toBe(true);
  });
});

describe("matchEmails — direct address matches are unaffected by the free-domain filter", () => {
  it("matches an exact free-domain address present in the emails table", async () => {
    // jane@gmail.com is stored directly in `emails`, owned by a person + org.
    state.emailsRows = [
      { personId: "p1", organizationId: "org1", householdId: null },
    ];
    // Even if an org had gmail.com in email_domain, the domain branch is
    // skipped — but the direct address lookup must still resolve.
    state.orgRows = [{ organizationId: "org-should-not-appear" }];

    const result = await matchEmails(["jane@gmail.com"], null);

    expect(result.personIds).toEqual(["p1"]);
    expect(result.organizationIds).toEqual(["org1"]);
    // The match came from the direct address lookup, not the domain branch.
    expect(state.orgQueried).toBe(false);
  });

  it("matches an exact free-domain address to a household", async () => {
    state.emailsRows = [
      { personId: null, organizationId: null, householdId: "hh1" },
    ];

    const result = await matchEmails(["family@icloud.com"], null);

    expect(result.householdIds).toEqual(["hh1"]);
    expect(state.orgQueried).toBe(false);
  });
});

describe("matchEmails — internal domains are dropped before matching", () => {
  it("drops @wildflowerschools.org staff addresses", async () => {
    // Even if an org mistakenly had this domain in email_domain it must
    // never be reached — internal addresses are stripped first.
    state.orgRows = [{ organizationId: "org-internal" }];

    const result = await matchEmails(["staff@wildflowerschools.org"], null);

    expect(result.personIds).toEqual([]);
    expect(result.organizationIds).toEqual([]);
    expect(result.householdIds).toEqual([]);
    expect(state.orgQueried).toBe(false);
  });

  it("drops @blackwildflowers.org staff addresses (second internal domain)", async () => {
    state.orgRows = [{ organizationId: "org-internal" }];

    const result = await matchEmails(["staff@blackwildflowers.org"], null);

    expect(result.personIds).toEqual([]);
    expect(result.organizationIds).toEqual([]);
    expect(result.householdIds).toEqual([]);
    expect(state.orgQueried).toBe(false);
  });

  it("keeps an outside donor while dropping a @blackwildflowers.org address", async () => {
    state.orgRows = [{ organizationId: "org-real" }];

    const result = await matchEmails(
      ["staff@blackwildflowers.org", "officer@realfunder.org"],
      null,
    );

    expect(result.organizationIds).toEqual(["org-real"]);
    expect(state.orgQueried).toBe(true);
  });
});
