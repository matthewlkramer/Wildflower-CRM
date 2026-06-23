import { describe, it, expect } from "vitest";
import {
  classifyStagedPayment,
  detectEntity,
  isGovernmentReimbursement,
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

  it("excludes loan-account payers as loan_repayment", () => {
    expect(
      classifyStagedPayment({ ...base, payerName: "Loan - Snowdrop" }).reason,
    ).toBe("loan_repayment");
  });

  it("excludes repayment payers as loan_repayment (case-insensitive)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Dahlia Montessori Repayment",
      }).reason,
    ).toBe("loan_repayment");
  });

  it("folds a guaranty-fee payer into earned_income (case-insensitive)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "echinacea GUARANTY  fee",
      }).reason,
    ).toBe("earned_income");
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

  it("zero_amount and loan_repayment take precedence over membership", () => {
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
    ).toBe("loan_repayment");
  });

  it("no longer EXCLUDES the funder 'CSP' — it stays in the queue", () => {
    // government_reimbursement is no longer a classifier exclusion: CSP money is
    // real and flows into the review queue like any other payment.
    expect(classifyStagedPayment({ ...base, payerName: "CSP" }).excluded).toBe(
      false,
    );
    expect(
      classifyStagedPayment({ ...base, payerName: "  csp  " }).excluded,
    ).toBe(false);
  });

  it("flags the funder 'CSP' as a government reimbursement (exact, case-insensitive)", () => {
    // The standalone detector marks the row so its eventual gift mints with
    // counts_toward_goal = false (real money that doesn't advance the goal).
    expect(isGovernmentReimbursement({ ...base, payerName: "CSP" })).toBe(true);
    expect(isGovernmentReimbursement({ ...base, payerName: "  csp  " })).toBe(
      true,
    );
  });

  it("does not flag 'CSP' substrings as a government reimbursement", () => {
    expect(
      isGovernmentReimbursement({ ...base, payerName: "CSPire Communications" }),
    ).toBe(false);
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

  it("excludes a bare 'Services - Earned Income' account name (no 4020 code) as earned_income", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "DC Wildflower Public Charter School",
        lineItemNames: ["Academic Support"],
        lineAccountNames: ["Services - Earned Income"],
      }).reason,
    ).toBe("earned_income");
  });

  it("does not match an 'Unearned Income' account name as earned_income", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["2400 Deferred / Unearned Income"],
      }).excluded,
    ).toBe(false);
  });

  it("does not match a 'Service Revenue' payer name (real grant/donation) as earned_income", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "DC Wildflower PCS - Service Revenue",
        lineAccountNames: ["4030 Other Revenue"],
        rawReference: "CHARTER FUND INC GRANT 1 OF 1",
      }).reason,
    ).not.toBe("earned_income");
  });

  it("donation-first guard keeps a bundled gift even with a bare earned-income account name", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: [
          "Services - Earned Income",
          "Unrestricted Donations - Individual",
        ],
      }).excluded,
    ).toBe(false);
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

  it("excludes a memo that says earned income as earned_income", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        rawReference: "ACH deposit - earned income for consulting",
      }).reason,
    ).toBe("earned_income");
  });

  it("excludes a line description that says service income as earned_income", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "Service Income - workshop fees",
      }).reason,
    ).toBe("earned_income");
  });

  it("donation-first guard keeps a bundled gift even with an earned-income memo", () => {
    expect(
      classifyStagedPayment({
        ...base,
        rawReference: "earned income",
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).excluded,
    ).toBe(false);
  });

  it("does not match 'unearned income' as earned_income", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        rawReference: "unearned income deferral",
      }).excluded,
    ).toBe(false);
  });

  it("folds guaranty revenue into earned_income (line-based)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        lineAccountNames: ["4102 Guaranty Revenue"],
      }).reason,
    ).toBe("earned_income");
    expect(
      classifyStagedPayment({
        ...base,
        lineItemNames: ["Springpoint:Guaranty Revenue"],
      }).reason,
    ).toBe("earned_income");
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

  it("CSP money stays in the queue even on a donation-coded line", () => {
    // No longer excluded — it flows into the queue but is flagged as a
    // government reimbursement so its eventual gift mints non-goal.
    const input = {
      ...base,
      payerName: "CSP",
      lineAccountNames: ["4000 Unrestricted Donations"],
    };
    expect(classifyStagedPayment(input).excluded).toBe(false);
    expect(isGovernmentReimbursement(input)).toBe(true);
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

  // ─── entity attribution (no longer excluded as fiscally_sponsored) ────────
  // Fiscally sponsored money is now ATTRIBUTED to its entity via detectEntity
  // and kept in the review queue, instead of being auto-excluded.
  it("attributes a fiscally sponsored project to its entity by QuickBooks Class (not excluded)", () => {
    const input: ClassifierInput = { ...base, lineClasses: ["Embracing Equity"] };
    expect(classifyStagedPayment(input).excluded).toBe(false);
    expect(detectEntity(input)).toBe("embracing_equity");
  });

  it("matches the entity marker case-insensitively and as a substring", () => {
    const input: ClassifierInput = {
      ...base,
      lineClasses: ["  EMBRACING EQUITY : Cohort 3  "],
    };
    expect(classifyStagedPayment(input).excluded).toBe(false);
    expect(detectEntity(input)).toBe("embracing_equity");
  });

  it("detects the entity marker on payer, item, account, memo or description", () => {
    expect(detectEntity({ ...base, payerName: "Embracing Equity" })).toBe(
      "embracing_equity",
    );
    expect(
      detectEntity({
        ...base,
        payerName: null,
        lineItemNames: ["Embracing Equity workshop"],
      }),
    ).toBe("embracing_equity");
    expect(
      detectEntity({
        ...base,
        payerName: null,
        lineAccountNames: ["Embracing Equity income"],
      }),
    ).toBe("embracing_equity");
    expect(
      detectEntity({
        ...base,
        payerName: null,
        rawReference: "deposit for Embracing Equity",
      }),
    ).toBe("embracing_equity");
    expect(
      detectEntity({
        ...base,
        payerName: null,
        lineDescription: "Embracing Equity program fees",
      }),
    ).toBe("embracing_equity");
  });

  it("attributes (does not exclude) a fiscally sponsored project EVEN when it carries a donation line", () => {
    // A donation coded to the other project is still the other project's money,
    // but it now stays in the review queue attributed to that entity.
    const input: ClassifierInput = {
      ...base,
      lineClasses: ["Embracing Equity"],
      lineItemNames: ["Donation - Individual Unrestricted"],
      lineAccountNames: ["4000 Unrestricted Donations"],
    };
    expect(classifyStagedPayment(input).excluded).toBe(false);
    expect(detectEntity(input)).toBe("embracing_equity");
  });

  it("detects each non-sunlight entity marker in declaration order", () => {
    expect(detectEntity({ ...base, payerName: "Black Wildflowers Fund" })).toBe(
      "black_wildflowers_fund",
    );
    expect(detectEntity({ ...base, payerName: "Tierra Indígena" })).toBe(
      "tierra_indigena",
    );
    expect(detectEntity({ ...base, payerName: "tierra indigena" })).toBe(
      "tierra_indigena",
    );
    expect(
      detectEntity({ ...base, lineClasses: ["Observant Education"] }),
    ).toBe("observation_support_tech");
    expect(
      detectEntity({ ...base, lineClasses: ["Observation Support Techs"] }),
    ).toBe("observation_support_tech");
    expect(detectEntity({ ...base, payerName: "Rising Tide" })).toBe(
      "rising_tide",
    );
  });

  it("does NOT attribute 'sunlight' money to an entity (ambiguous debt vs grants)", () => {
    // sunlight_debt and sunlight_grants are one entity split across two rows; a
    // bare "sunlight" marker cannot disambiguate, so it is intentionally omitted.
    const input: ClassifierInput = {
      ...base,
      payerName: "Sunlight",
      lineClasses: ["Sunlight Debt"],
    };
    expect(classifyStagedPayment(input).excluded).toBe(false);
    expect(detectEntity(input)).toBeNull();
  });

  it("does not exclude or attribute unrelated rows that merely mention 'equity'", () => {
    const input: ClassifierInput = {
      ...base,
      lineClasses: ["Equity Fund"],
      rawReference: "private equity distribution",
    };
    expect(classifyStagedPayment(input).excluded).toBe(false);
    expect(detectEntity(input)).toBeNull();
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
    // Only the COBRA marker triggers `insurance`; a generic mention does
    // not. (A 7006 Insurance expense account would be tax_refund, not insurance.)
    expect(
      classifyStagedPayment({
        ...base,
        rawReference: "annual insurance plan contribution",
      }).excluded,
    ).toBe(false);
  });

  it("excludes a COBRA reimbursement (bare 'COBRA', not 'BASICCOBRA') as insurance", () => {
    // QuickBooks deposits these as "COBRA TRUST ACCT BASICPacif…" — the BASIC
    // administrator name is glued to "Pacif", so the only marker is the separate
    // word COBRA. Posted to the "Benefit Liability" account, never a gift.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "COBRA TRUST ACCT BASICPacif",
        rawReference: "BUSINESS CHECKING (XXXXXX 8945)",
        lineAccountNames: ["2002 Benefit Liability"],
      }).reason,
    ).toBe("insurance");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Dandelion Parent Education Incorporated",
        rawReference: "Dan Grigsby Cobra",
        lineAccountNames: ["2002 Benefit Liability"],
      }).reason,
    ).toBe("insurance");
  });

  // ─── loan on the LINE detail (no loan-account payer) ──────────────────────
  it("excludes a 'LOAN REPAYMENT' line item as loan_repayment (generic payer)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Morgan Stanley",
        lineItemNames: ["LOAN REPAYMENT"],
        lineAccountNames: ["Loans to Schools"],
      }).reason,
    ).toBe("loan_repayment");
  });

  it("excludes a 'Loans to Schools' posting account as loan_repayment", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Snowdrop",
        lineAccountNames: ["1600 Loans to Schools"],
        lineDescription: "ATM CHECK DEPOSIT",
      }).reason,
    ).toBe("loan_repayment");
  });

  it("excludes a '… Repayment' deposit description as loan_repayment", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "Dahlia Montessori Repayment",
      }).reason,
    ).toBe("loan_repayment");
  });

  it("excludes 'PPP Loan Received' as loan_proceeds (borrowed funds in)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["2503 PPP Loan Received"],
        lineDescription: "PPP 2 Loan",
      }).reason,
    ).toBe("loan_proceeds");
  });

  it("excludes a 'Note Payable' liability booking as note_payable", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineAccountNames: ["2500 Notes Payable"],
        lineDescription: "Note payable draw",
      }).reason,
    ).toBe("note_payable");
  });

  it("does NOT sweep loan-fund capital posted to a contributions account", () => {
    // Loan-fund CAPITAL (money INTO the revolving fund) is a real gift posted to
    // a contributions account; the narrowed loan markers must let it fall through
    // to the queue rather than mislabel it loan_repayment/loan_proceeds.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "SpringPoint",
        lineItemNames: ["Loan Fund Investment"],
        lineAccountNames: ["4100 Restricted Donations:Loan Fund"],
        lineDescription: "Loan fund capital contribution",
      }).excluded,
    ).toBe(false);
  });

  it("does not treat loan-like line substrings as loans", () => {
    // Word-anchored: "loaning" / "Reloaning" on the line must not match.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "Reloaning program contribution",
      }).excluded,
    ).toBe(false);
  });

  it("prefers insurance over loan when a row matches both markers", () => {
    // insurance (step 4b) outranks the loan line/memo rule (step 5).
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "COBRA loan repayment",
      }).reason,
    ).toBe("insurance");
  });

  it("keeps a gift bundled with a loan line in the queue (donation-first guard)", () => {
    // A donation line on the same row suppresses the line/memo loan rule.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "Loan Fund repayment",
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).excluded,
    ).toBe(false);
  });

  // ─── loan marker on the CLASS only is NOT auto-excluded (deliberate) ───────
  // Evaluated against prod (2026-06-17): the "…:Loans" QuickBooks class bucket
  // that carries class-only school-loan rows (e.g. the $75k "Flor do Loto"
  // deposit) ALSO carries a tracked $500k US Bank CDFI loan-fund-investment gift
  // the org reconciles. The class can't tell them apart, so isLoanLineOrText
  // deliberately does NOT scan lineClasses — these rows stay in the queue for
  // manual review. See 0043_quickbooks_loan_class_decision_RUNBOOK.md.
  it("does NOT exclude a row whose only loan marker is on the QuickBooks class", () => {
    // The reported "Flor do Loto" shape: loan marker ONLY on the class.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Flor De Loto Montessori Corp",
        lineClasses: ["National (deleted):Loans (deleted)"],
        lineAccountNames: ["702 Grants to Schools"],
      }).excluded,
    ).toBe(false);
    // A bare "Loan Payment" class with no other marker also stays in the queue.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineClasses: ["Loan Payment (deleted)"],
      }).excluded,
    ).toBe(false);
  });

  it("still excludes a class-loan row when a loan marker ALSO sits on a scanned field", () => {
    // The class is ignored, but the existing line-detail rule still fires off
    // the posting account — so genuine school-loan repayments are unaffected.
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "WNYCS",
        lineClasses: ["National (deleted):Loans (deleted)"],
        lineAccountNames: ["1600 Loans to Schools"],
        rawReference: "WNYCS Loan Payment",
      }).reason,
    ).toBe("loan_repayment");
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

  // ─── expensify ────────────────────────────────────────────────────────────
  it("excludes an Expensify reimbursement on the payer as expensify", () => {
    expect(
      classifyStagedPayment({ ...base, payerName: "Expensify" }).reason,
    ).toBe("expensify");
  });

  it("matches the expensify marker case-insensitively on any field", () => {
    expect(
      classifyStagedPayment({ ...base, rawReference: "EXPENSIFY reimbursement" })
        .reason,
    ).toBe("expensify");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "Payment via expensify.com",
      }).reason,
    ).toBe("expensify");
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineItemNames: ["Expensify expense report"],
      }).reason,
    ).toBe("expensify");
  });

  it("excludes an expensify row EVEN when it carries a donation line (no donation guard)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: "Expensify",
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).reason,
    ).toBe("expensify");
  });

  it("does not fire expensify on unrelated text", () => {
    expect(
      classifyStagedPayment({
        ...base,
        rawReference: "expense report reimbursement",
      }).excluded,
    ).toBe(false);
  });

  // ─── returned_wire ────────────────────────────────────────────────────────
  it("excludes a returned wire transfer as returned_wire", () => {
    expect(
      classifyStagedPayment({ ...base, rawReference: "Returned Wire" }).reason,
    ).toBe("returned_wire");
  });

  it("matches the returned-wire marker case-insensitively and whitespace-tolerantly on any field", () => {
    expect(
      classifyStagedPayment({
        ...base,
        payerName: null,
        lineDescription: "RETURNED  WIRE - insufficient routing info",
      }).reason,
    ).toBe("returned_wire");
    expect(
      classifyStagedPayment({ ...base, payerName: "Returned wire" }).reason,
    ).toBe("returned_wire");
  });

  it("excludes a returned wire EVEN when it carries a donation line (no donation guard)", () => {
    expect(
      classifyStagedPayment({
        ...base,
        rawReference: "returned wire",
        lineItemNames: ["Donation - Individual Unrestricted"],
        lineAccountNames: ["4000 Unrestricted Donations"],
      }).reason,
    ).toBe("returned_wire");
  });

  it("does not fire returned_wire on unrelated 'wire' or 'returned' text", () => {
    expect(
      classifyStagedPayment({ ...base, rawReference: "incoming wire transfer" })
        .excluded,
    ).toBe(false);
    expect(
      classifyStagedPayment({ ...base, rawReference: "returned to sender" })
        .excluded,
    ).toBe(false);
  });
});
