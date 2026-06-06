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

  it("keeps an uninvoiced payment whose only coding is deposit-derived revenue", () => {
    // A bare Payment carries no lines of its own; for an uninvoiced one the
    // ONLY coding is folded in from the deposit line that re-records it (a
    // donation revenue account + memo). That deposit-derived signal must read
    // as a donation, not get swept into an exclusion.
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: null,
        lineAccountNames: ["4000 Unrestricted Donations"],
        rawReference: "Deposit memo: annual gift",
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

  it("excludes Realized Gain/Loss on Investments (4040) as interest", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["4040 Realized Gain/Loss on Investments"],
        rawReference: "Interest Earned",
      }).reason,
    ).toBe("interest");
  });

  it("excludes Realized Gain/Loss on Investments by NAME when the 4040 code is absent", () => {
    // QuickBooks sometimes emits the account name without the leading code.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Wells Fargo",
        lineAccountNames: ["Realized Gain/Loss on Investments"],
        lineItemNames: [
          "Government Grant - Unrestricted:Realized Gain/Loss on Investments",
        ],
      }).reason,
    ).toBe("interest");
  });

  it("excludes Interest Earned by NAME when the 4010 code is absent", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["  interest earned  "],
      }).reason,
    ).toBe("interest");
  });

  it("donation-first guard keeps a bundled gift even with a code-less gain/loss line", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: [
          "4000 Unrestricted Donations",
          "Realized Gain/Loss on Investments",
        ],
      }).excluded,
    ).toBe(false);
  });

  it("excludes Services - Earned Income (4020) as earned_income", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["4020 Services - Earned Income"],
      }).reason,
    ).toBe("earned_income");
  });

  it("interest (4040) outranks earned_income (4020) when both lines are present", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: [
          "4020 Services - Earned Income",
          "4040 Realized Gain/Loss on Investments",
        ],
      }).reason,
    ).toBe("interest");
  });

  it("donation-first guard keeps a bundled gift even with a 4020 earned-income line", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: [
          "4000 Unrestricted Donations",
          "4020 Services - Earned Income",
        ],
      }).excluded,
    ).toBe(false);
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

  it("excludes a fiscally sponsored project by its QuickBooks Class", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineClasses: ["Embracing Equity"],
      }).reason,
    ).toBe("fiscally_sponsored");
  });

  it("matches the fiscally sponsored marker case-insensitively and as a substring", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineClasses: ["  EMBRACING EQUITY : Cohort 3  "],
      }).reason,
    ).toBe("fiscally_sponsored");
  });

  it("matches the fiscally sponsored marker on payer, item, account or memo", () => {
    expect(
      classifyStagedPayment({ ...base, payerName: "Embracing Equity" }).reason,
    ).toBe("fiscally_sponsored");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineItemNames: ["Embracing Equity workshop"],
      }).reason,
    ).toBe("fiscally_sponsored");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["Embracing Equity income"],
      }).reason,
    ).toBe("fiscally_sponsored");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        rawReference: "deposit for Embracing Equity",
      }).reason,
    ).toBe("fiscally_sponsored");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "Embracing Equity program fees",
      }).reason,
    ).toBe("fiscally_sponsored");
  });

  it("excludes a fiscally sponsored project EVEN when it carries a donation line (no donation guard)", () => {
    // A donation coded to the other project is still the other project's money.
    expect(
      classifyStagedPayment({
        ...base,
        lineClasses: ["Embracing Equity"],
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).reason,
    ).toBe("fiscally_sponsored");
  });

  it("does not exclude unrelated rows that merely mention 'equity'", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineClasses: ["Equity Fund"],
        rawReference: "private equity distribution",
      }).excluded,
    ).toBe(false);
  });

  // ─── insurance (BASICCOBRA) ───────────────────────────────────────────────
  it("excludes a BASICCOBRA reimbursement as insurance (marker on the line)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "BASIC            BASICCOBRA 221215                 The Wildf",
        lineAccountNames: ["2002 Benefit Liability"],
      }).reason,
    ).toBe("insurance");
  });

  it("matches the BASICCOBRA marker case-insensitively on any field", () => {
    expect(
      classifyStagedPayment({ ...base, payerName: "BasicCobra Admin" }).reason,
    ).toBe("insurance");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        rawReference: "basiccobra premium remittance",
      }).reason,
    ).toBe("insurance");
  });

  it("excludes a BASICCOBRA row EVEN when it carries a donation line (no donation guard)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "BASICCOBRA premium",
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).reason,
    ).toBe("insurance");
  });

  it("does not treat the bare word 'insurance' as the insurance reason", () => {
    // Only the BASICCOBRA marker triggers `insurance`; a generic mention does
    // not. (A 7006 Insurance expense account would be tax_refund, not insurance.)
    expect(
      classifyStagedPayment({
        ...base,
        rawReference: "annual insurance plan contribution",
      }).excluded,
    ).toBe(false);
  });

  // ─── expense_refund (the word "refund") ───────────────────────────────────
  it("excludes a refund of the org's own expense as expense_refund", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Tina Garyantes",
        rawReference: "REFUND",
        lineAccountNames: [
          "7033 All Other Expenditures:Montessori Training Registrations",
        ],
      }).reason,
    ).toBe("expense_refund");
  });

  it("matches refund / refunds / refunded but not 'prefund'", () => {
    expect(
      classifyStagedPayment({ ...base, rawReference: "Overpay Refund" }).reason,
    ).toBe("expense_refund");
    expect(
      classifyStagedPayment({ ...base, rawReference: "registration refunds" })
        .reason,
    ).toBe("expense_refund");
    expect(
      classifyStagedPayment({ ...base, rawReference: "amount refunded" }).reason,
    ).toBe("expense_refund");
    expect(
      classifyStagedPayment({ ...base, rawReference: "prefund the account" })
        .excluded,
    ).toBe(false);
  });

  it("excludes an ERC refund miscoded to a donation account (no donation guard)", () => {
    // ERC tax refunds are sometimes coded in QuickBooks to a 4000-series
    // donation income account, but they are refunds, not gifts.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "US Department of Treasury",
        rawReference: "ERC Tax Refund",
        lineAccountNames: [
          "4000.4 Unrestricted Donations:Unrestricted Donations -Governmental",
        ],
      }).reason,
    ).toBe("expense_refund");
  });

  it("keeps the more specific tax_refund label when a refund posts to a tax account", () => {
    // tax_refund (guarded, account-based) runs before expense_refund, so a
    // refund coded to a payroll-tax / tax / insurance account stays tax_refund.
    expect(
      classifyStagedPayment({
        ...base,
        rawReference: "unemployment tax refund",
        lineAccountNames: ["7020 All Other Expenditures:Taxes"],
      }).reason,
    ).toBe("tax_refund");
  });
});
