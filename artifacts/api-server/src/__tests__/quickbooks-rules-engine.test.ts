import { describe, it, expect } from "vitest";
import {
  evaluateRules,
  type EngineRule,
} from "../lib/quickbooksRules";
import type { ClassifierInput } from "../lib/quickbooksExclusionRules";

/**
 * Unit coverage for the editable-rule engine primitives that the classifier
 * fidelity test does not exercise directly: ascending-priority first-match,
 * disabled-rule skipping, match logic (any/all), amount `lte`, regex, the
 * donation-first guard, and the `auto_create_approve` result shape.
 */

const base: ClassifierInput = {
  amount: "100.00",
  payerName: "Generous Donor",
  lineItemNames: null,
  lineAccountNames: null,
  rawReference: null,
};

function excludeRule(over: Partial<EngineRule>): EngineRule {
  return {
    id: "r",
    enabled: true,
    priority: 10,
    action: "exclude",
    exclusionReason: "loan",
    donationGuard: false,
    matchLogic: "any",
    conditions: [{ field: "payer_name", mode: "contains", value: "donor" }],
    targetOrganizationId: null,
    targetIntendedUsage: null,
    targetFundableProjectId: null,
    ...over,
  };
}

describe("evaluateRules", () => {
  it("returns null when nothing matches", () => {
    const rule = excludeRule({
      conditions: [{ field: "payer_name", mode: "contains", value: "zzz" }],
    });
    expect(evaluateRules([rule], base)).toBeNull();
  });

  it("skips disabled rules", () => {
    const rule = excludeRule({ enabled: false });
    expect(evaluateRules([rule], base)).toBeNull();
  });

  it("first matching rule by ascending priority wins", () => {
    const low = excludeRule({
      id: "low",
      priority: 5,
      exclusionReason: "loan",
    });
    const high = excludeRule({
      id: "high",
      priority: 50,
      exclusionReason: "interest",
    });
    const res = evaluateRules([high, low], base);
    expect(res).toEqual({ action: "exclude", reason: "loan", ruleId: "low" });
  });

  it("a misconfigured exclude rule with no reason is a no-op", () => {
    const rule = excludeRule({ exclusionReason: null });
    expect(evaluateRules([rule], base)).toBeNull();
  });

  it("matchLogic 'all' requires every condition", () => {
    const rule = excludeRule({
      matchLogic: "all",
      conditions: [
        { field: "payer_name", mode: "contains", value: "donor" },
        { field: "payer_name", mode: "contains", value: "missing" },
      ],
    });
    expect(evaluateRules([rule], base)).toBeNull();
    const ok = excludeRule({
      matchLogic: "all",
      conditions: [
        { field: "payer_name", mode: "contains", value: "generous" },
        { field: "payer_name", mode: "contains", value: "donor" },
      ],
    });
    expect(evaluateRules([ok], base)?.action).toBe("exclude");
  });

  it("amount lte matches at or below the threshold", () => {
    const rule = excludeRule({
      exclusionReason: "zero_amount",
      conditions: [{ field: "amount", mode: "lte", value: "0" }],
    });
    expect(evaluateRules([rule], { ...base, amount: "0.00" })?.action).toBe(
      "exclude",
    );
    expect(evaluateRules([rule], { ...base, amount: "5.00" })).toBeNull();
    // null / non-numeric amount is treated as <= (mirrors classifier).
    expect(evaluateRules([rule], { ...base, amount: null })?.action).toBe(
      "exclude",
    );
  });

  it("regex matches case-insensitively; an invalid pattern never matches", () => {
    const rule = excludeRule({
      conditions: [{ field: "payer_name", mode: "regex", value: "gen.*donor" }],
    });
    expect(evaluateRules([rule], base)?.action).toBe("exclude");
    const bad = excludeRule({
      conditions: [{ field: "payer_name", mode: "regex", value: "(" }],
    });
    expect(evaluateRules([bad], base)).toBeNull();
  });

  it("donationGuard suppresses the rule when a donation line is present", () => {
    const guarded = excludeRule({
      donationGuard: true,
      conditions: [{ field: "payer_name", mode: "contains", value: "donor" }],
    });
    const withDonation: ClassifierInput = {
      ...base,
      lineItemNames: ["General Donation"],
    };
    expect(evaluateRules([guarded], withDonation)).toBeNull();
    // Same rule unguarded still fires.
    const unguarded = excludeRule({
      donationGuard: false,
      conditions: [{ field: "payer_name", mode: "contains", value: "donor" }],
    });
    expect(evaluateRules([unguarded], withDonation)?.action).toBe("exclude");
  });

  it("returns the auto_create_approve target payload", () => {
    const rule = excludeRule({
      id: "amazon",
      action: "auto_create_approve",
      exclusionReason: null,
      conditions: [
        { field: "any_text", mode: "contains", value: "amazonsmile" },
      ],
      targetOrganizationId: "recAmazon",
      targetIntendedUsage: "gen_ops",
      targetFundableProjectId: null,
    });
    const input: ClassifierInput = {
      ...base,
      rawReference: "AmazonSmile donation",
    };
    expect(evaluateRules([rule], input)).toEqual({
      action: "auto_create_approve",
      ruleId: "amazon",
      targetOrganizationId: "recAmazon",
      targetIntendedUsage: "gen_ops",
      targetFundableProjectId: null,
    });
  });
});
