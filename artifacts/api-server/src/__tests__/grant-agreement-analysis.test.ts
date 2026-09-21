import { describe, expect, it } from "vitest";
import { normalizeAnalyzedGrantTerm } from "../lib/grantAgreementAnalysis";

const base = {
  kind: "condition",
  restrictionDimension: null,
  spendingRuleType: null,
  title: "Submit annual report",
  summary: "The second payment follows the annual report.",
  exactQuote: "The second payment will be issued after receipt of the report.",
  sourcePage: "2",
  amount: null,
  startDate: null,
  endDate: null,
  dueDate: "2027-03-01",
  barrier: "Submit an annual report",
  returnOrReleaseRight: null,
  consequence: null,
  categories: null,
  capAmount: null,
  capPercent: null,
};

describe("normalizeAnalyzedGrantTerm", () => {
  it("does not classify report-before-payment language as a formal condition without a return or release right", () => {
    expect(normalizeAnalyzedGrantTerm(base)?.kind).toBe("other_requirement");
  });

  it("requires a restriction dimension before changing restriction coding", () => {
    expect(
      normalizeAnalyzedGrantTerm({
        ...base,
        kind: "donor_restriction",
        barrier: null,
      })?.kind,
    ).toBe("other_requirement");
  });

  it("discards malformed database values from model output", () => {
    const normalized = normalizeAnalyzedGrantTerm({
      ...base,
      kind: "spending_rule",
      spendingRuleType: "cap",
      amount: "unknown",
      dueDate: "next spring",
      capAmount: "-50",
      capPercent: "15",
    });
    expect(normalized).toMatchObject({
      kind: "spending_rule",
      amount: null,
      dueDate: null,
      capAmount: null,
      capPercent: null,
    });
  });
});
