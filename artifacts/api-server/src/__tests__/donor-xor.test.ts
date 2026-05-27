import { describe, it, expect } from "vitest";
import {
  validateOppInvariants,
  validateGiftInvariants,
  DONOR_XOR_MESSAGE,
} from "@workspace/api-zod";

describe("donor XOR invariants", () => {
  const cases: Array<[string, Record<string, string | null>, boolean]> = [
    ["funder only", { funderId: "f1" }, true],
    ["individual only", { individualGiverPersonId: "p1" }, true],
    ["household only", { householdId: "h1" }, true],
    ["none set", {}, false],
    ["funder + individual", { funderId: "f1", individualGiverPersonId: "p1" }, false],
    ["funder + household", { funderId: "f1", householdId: "h1" }, false],
    ["all three", { funderId: "f1", individualGiverPersonId: "p1", householdId: "h1" }, false],
    ["funder = empty string still counts as set", { funderId: "" }, true],
  ];

  for (const [name, state, ok] of cases) {
    it(`opp: ${name} → ${ok ? "valid" : "invalid"}`, () => {
      const issues = validateOppInvariants(state);
      expect(issues.length === 0).toBe(ok);
      if (!ok) expect(issues[0]?.message).toBe(DONOR_XOR_MESSAGE);
    });
    it(`gift: ${name} → ${ok ? "valid" : "invalid"}`, () => {
      const issues = validateGiftInvariants(state);
      expect(issues.length === 0).toBe(ok);
    });
  }
});
