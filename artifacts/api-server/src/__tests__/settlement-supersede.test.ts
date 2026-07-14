import { describe, expect, it } from "vitest";
import { stripeGrossCoversQbApplication } from "../lib/settlementSupersede";

describe("stripeGrossCoversQbApplication", () => {
  it("accepts an exact net/gross match", () => {
    expect(stripeGrossCoversQbApplication("100.00", "100.00")).toBe(true);
  });

  it("accepts processor gross above QBO net inside the shared fee band", () => {
    expect(stripeGrossCoversQbApplication("148.90", "156.48")).toBe(true);
    expect(stripeGrossCoversQbApplication("5025.88", "5176.29")).toBe(true);
  });

  it("accepts the upper fee-band boundary", () => {
    expect(stripeGrossCoversQbApplication("100.00", "111.00")).toBe(true);
  });

  it("rejects an amount above the upper fee-band boundary", () => {
    expect(stripeGrossCoversQbApplication("100.00", "111.01")).toBe(false);
  });

  it("rejects partial Stripe coverage", () => {
    expect(stripeGrossCoversQbApplication("100.00", "60.00")).toBe(false);
  });

  it("rejects missing or invalid coverage inputs", () => {
    expect(stripeGrossCoversQbApplication(null, "100.00")).toBe(false);
    expect(stripeGrossCoversQbApplication("100.00", null)).toBe(false);
    expect(stripeGrossCoversQbApplication("not-a-number", "100.00")).toBe(false);
  });
});
