import { describe, it, expect } from "vitest";
import {
  canSeeIdentity,
  canManageIdentity,
  displayOrganizationName,
  displayPersonName,
  ANONYMOUS_LABEL,
} from "./visibility";

const owner = { id: "u1", role: "user" };
const otherUser = { id: "u2", role: "user" };
const admin = { id: "u3", role: "admin" };

describe("canSeeIdentity", () => {
  it("shows non-anonymous records to everyone (incl. anonymous viewer)", () => {
    const rec = { anonymous: false, ownerUserId: "u1" };
    expect(canSeeIdentity(rec, owner)).toBe(true);
    expect(canSeeIdentity(rec, otherUser)).toBe(true);
    expect(canSeeIdentity(rec, null)).toBe(true);
  });

  it("hides anonymous records from non-owners and signed-out viewers", () => {
    const rec = { anonymous: true, ownerUserId: "u1" };
    expect(canSeeIdentity(rec, otherUser)).toBe(false);
    expect(canSeeIdentity(rec, null)).toBe(false);
    expect(canSeeIdentity(rec, undefined)).toBe(false);
  });

  it("reveals anonymous records to the owner and admins", () => {
    const rec = { anonymous: true, ownerUserId: "u1" };
    expect(canSeeIdentity(rec, owner)).toBe(true);
    expect(canSeeIdentity(rec, admin)).toBe(true);
  });
});

describe("canManageIdentity", () => {
  it("does not depend on the anonymous flag", () => {
    const visible = { anonymous: false, ownerUserId: "u1" };
    const hidden = { anonymous: true, ownerUserId: "u1" };
    // Non-owner cannot toggle even when the record is currently visible.
    expect(canManageIdentity(visible, otherUser)).toBe(false);
    expect(canManageIdentity(hidden, otherUser)).toBe(false);
  });

  it("allows only owner and admins", () => {
    const rec = { ownerUserId: "u1" };
    expect(canManageIdentity(rec, owner)).toBe(true);
    expect(canManageIdentity(rec, admin)).toBe(true);
    expect(canManageIdentity(rec, otherUser)).toBe(false);
    expect(canManageIdentity(rec, null)).toBe(false);
  });
});

describe("display helpers", () => {
  it("masks organization name for unauthorized viewers", () => {
    const funder = { name: "Acme Foundation", anonymous: true, ownerUserId: "u1" };
    expect(displayOrganizationName(funder, otherUser)).toBe(ANONYMOUS_LABEL);
    expect(displayOrganizationName(funder, owner)).toBe("Acme Foundation");
  });

  it("masks person name for unauthorized viewers", () => {
    const person = {
      fullName: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      nickname: null,
      id: "p1",
      anonymous: true,
      ownerUserId: "u1",
    };
    expect(displayPersonName(person, otherUser)).toBe(ANONYMOUS_LABEL);
    expect(displayPersonName(person, admin)).toBe("Jane Doe");
  });
});
