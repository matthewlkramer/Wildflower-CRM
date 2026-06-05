import { describe, it, expect } from "vitest";
import {
  classifyStagedPayment,
  type ClassifierInput,
} from "../lib/quickbooksExclusionRules";

const base: ClassifierInput = {
  amount: "100.00",
  payerName: "Generous Donor",
  lineItemNames: null,
  lineAccountNames: null,
  rawReference: null,
};

describe("classifyStagedPayment", () => {
  it("does not exclude an ordinary donation", () => {
    expect(classifyStagedPayment(base)).toEqual({
      excluded: false,
      reason: null,
    });
  });

  it("excludes null amounts as zero_amount", () => {
    expect(classifyStagedPayment({ ...base, amount: null })).toEqual({
      excluded: true,
      reason: "zero_amount",
    });
  });

  it("excludes zero and negative amounts as zero_amount", () => {
    expect(classifyStagedPayment({ ...base, amount: "0.00" }).reason).toBe(
      "zero_amount",
    );
    expect(classifyStagedPayment({ ...base, amount: "-25.00" }).reason).toBe(
      "zero_amount",
    );
  });

  it("excludes a non-numeric amount as zero_amount", () => {
    expect(classifyStagedPayment({ ...base, amount: "n/a" }).reason).toBe(
      "zero_amount",
    );
  });

  it("excludes loan-account payers", () => {
    expect(
      classifyStagedPayment({ ...base, payerName: "Loan - Snowdrop" }).reason,
    ).toBe("loan");
  });

  it("excludes repayments and guaranty fees (case-insensitive)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Dahlia Montessori Repayment",
      }).reason,
    ).toBe("loan");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "echinacea GUARANTY  fee",
      }).reason,
    ).toBe("loan");
  });

  it("does not treat loan-like substrings as loans", () => {
    expect(
      classifyStagedPayment({ ...base, payerName: "Reloaning Partners" })
        .excluded,
    ).toBe(false);
  });

  it("zero_amount takes precedence over loan", () => {
    expect(
      classifyStagedPayment({
        ...base,
        amount: "0",
        payerName: "Loan - Snowdrop",
      }).reason,
    ).toBe("zero_amount");
  });

  it("excludes the confirmed 'School Contributions' membership item", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["School Contributions"],
      }).reason,
    ).toBe("membership");
  });

  it("matches the membership item case-insensitively after trim", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["  school contributions  "],
      }).reason,
    ).toBe("membership");
  });

  it("does not exclude unrelated line items as membership", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).excluded,
    ).toBe(false);
  });

  it("zero_amount and loan take precedence over membership", () => {
    expect(
      classifyStagedPayment({
        ...base,
        amount: "0",
        lineItemNames: ["School Contributions"],
      }).reason,
    ).toBe("zero_amount");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Loan - Snowdrop",
        lineItemNames: ["School Contributions"],
      }).reason,
    ).toBe("loan");
  });

  it("excludes the funder 'CSP' as government_reimbursement (exact, case-insensitive)", () => {
    expect(classifyStagedPayment({ ...base, payerName: "CSP" }).reason).toBe(
      "government_reimbursement",
    );
    expect(classifyStagedPayment({ ...base, payerName: "  csp  " }).reason).toBe(
      "government_reimbursement",
    );
  });

  it("does not treat 'CSP' substrings as government_reimbursement", () => {
    expect(
      classifyStagedPayment({ ...base, payerName: "CSPire Communications" })
        .excluded,
    ).toBe(false);
  });

  it("excludes interest income by account and by item", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["4010 Interest Earned"],
      }).reason,
    ).toBe("interest");
    expect(
      classifyStagedPayment({ ...base, lineItemNames: ["INTEREST"] }).reason,
    ).toBe("interest");
  });

  it("excludes guaranty revenue as loan activity (line-based)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["4102 Guaranty Revenue"],
      }).reason,
    ).toBe("loan");
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Springpoint:Guaranty Revenue"],
      }).reason,
    ).toBe("loan");
  });

  it("excludes payroll-tax / tax / insurance refunds as tax_refund", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["7010.4 Payroll:3.Benefits:Payroll Taxes"],
      }).reason,
    ).toBe("tax_refund");
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["7006 All Other Expenditures:Insurance"],
      }).reason,
    ).toBe("tax_refund");
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["7020 All Other Expenditures:Taxes"],
      }).reason,
    ).toBe("tax_refund");
  });

  it("does not treat unrelated expense accounts as tax_refund", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["7003 All Other Expenditures:Bank Charges"],
      }).excluded,
    ).toBe(false);
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["7011 All Other Expenditures:Office Supplies"],
      }).excluded,
    ).toBe(false);
  });

  it("donation-first guard keeps a bundled gift even with an interest line", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations", "4010 Interest Earned"],
      }).excluded,
    ).toBe(false);
  });

  it("donation-first guard protects bundled gifts from guaranty / tax_refund lines", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["4100 Restricted Donations", "4102 Guaranty Revenue"],
      }).excluded,
    ).toBe(false);
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Donation - Foundation"],
        lineAccountNames: ["7010.4 Payroll:3.Benefits:Payroll Taxes"],
      }).excluded,
    ).toBe(false);
  });

  it("CSP exclusion is definitive even on a donation-coded line", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "CSP",
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).reason,
    ).toBe("government_reimbursement");
  });

  it("interest account 4010 is not mistaken for a 4000-series donation", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["4010 Interest Earned"],
      }).reason,
    ).toBe("interest");
  });

  it("excludes Other Revenue credit-card rewards as other_revenue", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["4030 Other Revenue"],
        rawReference: "Wells Fargo Credit Card rewards",
      }).reason,
    ).toBe("other_revenue");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["4030 Other Revenue"],
        rawReference: "Check: X530 $500.00 - WF rewards, coded to FO, general",
      }).reason,
    ).toBe("other_revenue");
  });

  it("excludes Other Revenue bank-account activity as other_revenue", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["4030 Other Revenue"],
        rawReference: "BUSINESS CHECKING (XXXXXX 8945)",
      }).reason,
    ).toBe("other_revenue");
  });

  it("leaves other Other-Revenue rows in the queue for review", () => {
    // Legal settlement / unidentified deposit coded to 4030 but without a
    // rewards / bank-account memo stays pending.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["4030 Other Revenue"],
        rawReference: "Legal settlement - Sweet Pea",
      }).excluded,
    ).toBe(false);
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["4030 Other Revenue"],
        rawReference: null,
      }).excluded,
    ).toBe(false);
  });

  it("only treats the rewards/bank memo as other_revenue when coded to 4030", () => {
    // Same memo on a donation-coded line must not be hidden.
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["4000 Unrestricted Donations"],
        rawReference: "credit card rewards",
      }).excluded,
    ).toBe(false);
  });

  it("donation-first guard protects a bundled gift on a 4030 line", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations", "4030 Other Revenue"],
        rawReference: "credit card rewards",
      }).excluded,
    ).toBe(false);
  });
});
