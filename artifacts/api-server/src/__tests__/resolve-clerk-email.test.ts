import { describe, it, expect } from "vitest";
import {
  pickClerkEmail,
  resolveClerkEmail,
  type ClerkUserLike,
} from "../lib/resolveClerkEmail";

describe("pickClerkEmail", () => {
  it("returns the primary email (lowercased) when designated", () => {
    const u: ClerkUserLike = {
      primaryEmailAddressId: "e2",
      emailAddresses: [
        { id: "e1", emailAddress: "alt@wildflowerschools.org" },
        { id: "e2", emailAddress: "Matthew.Kramer@WildflowerSchools.org" },
      ],
    };
    expect(pickClerkEmail(u)).toBe("matthew.kramer@wildflowerschools.org");
  });

  it("falls back to the first address when no primary is set", () => {
    const u: ClerkUserLike = {
      emailAddresses: [{ id: "e1", emailAddress: "First@wildflowerschools.org" }],
    };
    expect(pickClerkEmail(u)).toBe("first@wildflowerschools.org");
  });

  it("returns undefined when there are no addresses", () => {
    expect(pickClerkEmail({ emailAddresses: [] })).toBeUndefined();
    expect(pickClerkEmail({})).toBeUndefined();
  });
});

describe("resolveClerkEmail", () => {
  it("uses the session-claim email when present (no backend call)", async () => {
    let called = false;
    const email = await resolveClerkEmail("user_1", "Claim@Wildflowerschools.org", async () => {
      called = true;
      return {};
    });
    expect(email).toBe("claim@wildflowerschools.org");
    expect(called).toBe(false);
  });

  it("falls back to the Clerk backend lookup when claim is missing", async () => {
    const email = await resolveClerkEmail("user_42", undefined, async (id) => {
      expect(id).toBe("user_42");
      return {
        primaryEmailAddressId: "e1",
        emailAddresses: [{ id: "e1", emailAddress: "erica.cantoni@wildflowerschools.org" }],
      };
    });
    expect(email).toBe("erica.cantoni@wildflowerschools.org");
  });

  it("returns undefined when the backend lookup throws", async () => {
    const email = await resolveClerkEmail("user_x", undefined, async () => {
      throw new Error("clerk down");
    });
    expect(email).toBeUndefined();
  });
});
