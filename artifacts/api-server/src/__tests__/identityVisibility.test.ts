import { describe, it, expect } from "vitest";
import {
  ANON_LABEL,
  canSeeIdentity,
  maskName,
  type Viewer,
} from "../lib/identityVisibility";

const OWNER: Viewer = { id: "owner_1", role: "team_member" };
const OTHER: Viewer = { id: "other_2", role: "team_member" };
const ADMIN: Viewer = { id: "admin_3", role: "admin" };

const notAnon = { anonymous: false, ownerUserId: "owner_1" };
const anon = { anonymous: true, ownerUserId: "owner_1" };

describe("identityVisibility.canSeeIdentity", () => {
  it("is visible when the entity is not anonymous (any viewer)", () => {
    expect(canSeeIdentity(notAnon, OTHER)).toBe(true);
    expect(canSeeIdentity({ anonymous: null, ownerUserId: "owner_1" }, OTHER)).toBe(true);
  });

  it("is visible to an admin even when anonymous", () => {
    expect(canSeeIdentity(anon, ADMIN)).toBe(true);
  });

  it("is visible to the record owner even when anonymous", () => {
    expect(canSeeIdentity(anon, OWNER)).toBe(true);
  });

  it("is hidden from a non-owner non-admin when anonymous", () => {
    expect(canSeeIdentity(anon, OTHER)).toBe(false);
  });
});

describe("identityVisibility.maskName", () => {
  it("returns the real name when not anonymous", () => {
    expect(maskName("Acme Foundation", notAnon, OTHER)).toBe("Acme Foundation");
  });

  it("returns the real name to an admin when anonymous", () => {
    expect(maskName("Acme Foundation", anon, ADMIN)).toBe("Acme Foundation");
  });

  it("returns the real name to the owner when anonymous", () => {
    expect(maskName("Acme Foundation", anon, OWNER)).toBe("Acme Foundation");
  });

  it("returns ANON_LABEL to a non-owner non-admin when anonymous", () => {
    expect(maskName("Acme Foundation", anon, OTHER)).toBe(ANON_LABEL);
  });

  it("returns ANON_LABEL when hidden even if the underlying name is null", () => {
    expect(maskName(null, anon, OTHER)).toBe(ANON_LABEL);
  });

  it("passes through a null name when visible", () => {
    expect(maskName(null, notAnon, OTHER)).toBeNull();
  });
});
