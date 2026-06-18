import { describe, it, expect } from "vitest";
import {
  classifyStagedPayment,
  type ClassifierInput,
} from "../lib/quickbooksExclusionRules";
import { evaluateRules, SEED_RULES } from "../lib/quickbooksRules";

/**
 * Fidelity guard: the seeded `quickbooks_handling_rules` rule set (SEED_RULES)
 * must reproduce the hardcoded `classifyStagedPayment` classifier exactly for the
 * INGEST path. For every fixture, `evaluateRules(SEED_RULES)` must agree with
 * `classifyStagedPayment` on whether the row is excluded and with which reason.
 * (The AmazonSmile `auto_create_approve` rule is exercised separately — none of
 * these classifier fixtures contain the "amazonsmile" marker.)
 */

const base: ClassifierInput = {
  amount: "100.00",
  payerName: "Generous Donor",
  lineItemNames: null,
  lineAccountNames: null,
  rawReference: null,
};

const fixtures: { name: string; input: ClassifierInput }[] = [
  { name: "ordinary donation", input: base },
  { name: "null amount", input: { ...base, amount: null } },
  { name: "zero amount", input: { ...base, amount: "0.00" } },
  { name: "negative amount", input: { ...base, amount: "-25.00" } },
  { name: "non-numeric amount", input: { ...base, amount: "n/a" } },
  { name: "loan payer", input: { ...base, payerName: "Loan - Snowdrop" } },
  {
    name: "repayment payer",
    input: { ...base, payerName: "Dahlia Montessori Repayment" },
  },
  {
    name: "guaranty fee payer",
    input: { ...base, payerName: "Guaranty Fee - Tulip" },
  },
  {
    name: "reloaning payer (must NOT match loan)",
    input: { ...base, payerName: "Reloaning Partners LLC" },
  },
  { name: "government reimbursement CSP", input: { ...base, payerName: "CSP" } },
  {
    name: "fiscally sponsored class",
    input: { ...base, lineClasses: ["Embracing Equity"] },
  },
  {
    name: "fiscally sponsored on item",
    input: { ...base, lineItemNames: ["Embracing Equity Program"] },
  },
  {
    name: "insurance cobra memo",
    input: { ...base, rawReference: "COBRA TRUST ACCT 12345" },
  },
  {
    name: "expensify memo",
    input: { ...base, rawReference: "EXPENSIFY reimbursement" },
  },
  {
    name: "returned wire",
    input: { ...base, rawReference: "RETURNED WIRE 998877" },
  },
  {
    name: "loan line item",
    input: { ...base, lineItemNames: ["LOAN REPAYMENT"] },
  },
  {
    name: "loan account name",
    input: { ...base, lineAccountNames: ["Loans to Schools"] },
  },
  {
    name: "loan line but bundled with donation (guard suppresses)",
    input: {
      ...base,
      lineItemNames: ["LOAN REPAYMENT", "Donation"],
      lineAccountNames: ["4000 Contributions"],
    },
  },
  {
    name: "guaranty account 4102",
    input: { ...base, lineAccountNames: ["4102 Guaranty Revenue"] },
  },
  {
    name: "guaranty item",
    input: { ...base, lineItemNames: ["Guaranty Fee"] },
  },
  {
    name: "interest account 4010",
    input: { ...base, lineAccountNames: ["4010 Interest Earned"] },
  },
  {
    name: "interest account 4040",
    input: { ...base, lineAccountNames: ["4040 Realized Gain"] },
  },
  {
    name: "interest account name only",
    input: { ...base, lineAccountNames: ["Realized Gain/Loss on Investments"] },
  },
  {
    name: "interest item",
    input: { ...base, lineItemNames: ["Interest Income"] },
  },
  {
    name: "tax refund 7010.4",
    input: { ...base, lineAccountNames: ["7010.4 Payroll Taxes"] },
  },
  {
    name: "tax refund 7020",
    input: { ...base, lineAccountNames: ["7020 Taxes"] },
  },
  {
    name: "tax refund 7006",
    input: { ...base, lineAccountNames: ["7006 Insurance"] },
  },
  {
    name: "other revenue rewards memo",
    input: {
      ...base,
      lineAccountNames: ["4030 Other Revenue"],
      rawReference: "Credit card rewards",
    },
  },
  {
    name: "other revenue business checking desc",
    input: {
      ...base,
      lineAccountNames: ["4030 Other Revenue"],
      lineDescription: "BUSINESS CHECKING (XXXXXX 8945)",
    },
  },
  {
    name: "other revenue 4030 without memo marker (NOT excluded)",
    input: {
      ...base,
      lineAccountNames: ["4030 Other Revenue"],
      rawReference: "Legal settlement",
    },
  },
  {
    name: "earned income 4020",
    input: { ...base, lineAccountNames: ["4020 Services - Earned Income"] },
  },
  {
    name: "earned income bundled with donation (guard suppresses)",
    input: {
      ...base,
      lineAccountNames: ["4020 Services - Earned Income", "4100 Donations"],
    },
  },
  {
    name: "earned income memo",
    input: {
      ...base,
      payerName: null,
      rawReference: "earned income - consulting fees",
    },
  },
  {
    name: "service income line description",
    input: {
      ...base,
      payerName: null,
      lineDescription: "Service Income workshop",
    },
  },
  {
    name: "earned income memo bundled with donation (guard suppresses)",
    input: {
      ...base,
      rawReference: "earned income",
      lineItemNames: ["Donation"],
      lineAccountNames: ["4000 Contributions"],
    },
  },
  {
    name: "unearned income must NOT match earned_income",
    input: { ...base, payerName: null, rawReference: "unearned income deferral" },
  },
  {
    name: "earned/income split across memo + description must NOT match",
    input: {
      ...base,
      payerName: null,
      rawReference: "earned",
      lineDescription: "income",
    },
  },
  {
    name: "expense refund text",
    input: { ...base, rawReference: "Vendor refund check" },
  },
  {
    name: "prefund must NOT match refund",
    input: { ...base, rawReference: "Prefund deposit" },
  },
  {
    name: "membership school contributions item",
    input: { ...base, lineItemNames: ["School Contributions"] },
  },
  {
    name: "tax refund wins over expense refund word",
    input: {
      ...base,
      lineAccountNames: ["7020 Taxes"],
      rawReference: "tax refund",
    },
  },
];

describe("evaluateRules(SEED_RULES) fidelity vs classifyStagedPayment", () => {
  for (const { name, input } of fixtures) {
    it(`matches classifier for: ${name}`, () => {
      const classifier = classifyStagedPayment(input);
      const engine = evaluateRules(SEED_RULES, input);

      if (classifier.excluded) {
        expect(engine).not.toBeNull();
        expect(engine?.action).toBe("exclude");
        if (engine?.action === "exclude") {
          expect(engine.reason).toBe(classifier.reason);
        }
      } else {
        // Classifier did not exclude → engine must not exclude either. (No fixture
        // carries the amazonsmile auto_create marker, so the engine returns null.)
        expect(
          engine === null || engine.action !== "exclude",
        ).toBe(true);
      }
    });
  }

  it("AmazonSmile fires the auto_create_approve rule", () => {
    const res = evaluateRules(SEED_RULES, {
      ...base,
      rawReference: "AmazonSmile donation payout",
    });
    expect(res?.action).toBe("auto_create_approve");
    if (res?.action === "auto_create_approve") {
      expect(res.targetIntendedUsage).toBe("gen_ops");
    }
  });

  it("AmazonSmile does not fire on zero amount (zero_amount wins)", () => {
    const res = evaluateRules(SEED_RULES, {
      ...base,
      amount: "0",
      rawReference: "AmazonSmile donation payout",
    });
    expect(res?.action).toBe("exclude");
  });
});
