import { describe, it, expect } from "vitest";
import {
  validateMeetingContactInvariants,
  MEETING_CONTACT_XOR_MESSAGE,
} from "@workspace/api-zod";

describe("meeting-notes contact XOR", () => {
  const cases: Array<[string, Record<string, string | null | undefined>, boolean]> = [
    ["person only", { personId: "p1" }, true],
    ["funder only", { organizationId: "f1" }, true],
    ["household only", { householdId: "h1" }, true],
    ["none set", {}, false],
    ["all null", { personId: null, organizationId: null, householdId: null }, false],
    ["person + funder", { personId: "p1", organizationId: "f1" }, false],
    ["person + household", { personId: "p1", householdId: "h1" }, false],
    ["funder + household", { organizationId: "f1", householdId: "h1" }, false],
    ["all three", { personId: "p1", organizationId: "f1", householdId: "h1" }, false],
    // Empty string still counts as "set" — same semantics as donor-xor.
    // Routes use parseOrBadRequest which gates on the field actually
    // being present, so this branch is defensive but consistent.
    ["person = empty string still counts as set", { personId: "" }, true],
  ];

  for (const [name, state, ok] of cases) {
    it(`${name} → ${ok ? "valid" : "invalid"}`, () => {
      const issues = validateMeetingContactInvariants(state);
      expect(issues.length === 0).toBe(ok);
      if (!ok) expect(issues[0]?.message).toBe(MEETING_CONTACT_XOR_MESSAGE);
    });
  }
});
