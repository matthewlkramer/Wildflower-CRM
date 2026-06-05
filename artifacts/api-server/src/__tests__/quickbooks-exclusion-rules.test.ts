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
});
