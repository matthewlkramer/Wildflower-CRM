import { describe, expect, it } from "vitest";
import { validateAttachmentComposition } from "../lib/quickbooksAttachmentComposition";

describe("validateAttachmentComposition", () => {
  it("accepts multiple checks that exactly cover the deposit", () => {
    expect(
      validateAttachmentComposition("2034.28", [
        {
          amount: "$2,025.57",
          payerName: "Village Montessori",
          checkNumber: "1842",
        },
        { amount: "8.71", payerName: "Another payer" },
      ]),
    ).toEqual([
      {
        amount: "2025.57",
        payerName: "Village Montessori",
        checkNumber: "1842",
        reference: null,
      },
      {
        amount: "8.71",
        payerName: "Another payer",
        checkNumber: null,
        reference: null,
      },
    ]);
  });

  it("rejects partial, overallocated, and single-payment evidence", () => {
    expect(
      validateAttachmentComposition("2034.28", [{ amount: "2025.57" }]),
    ).toBeNull();
    expect(
      validateAttachmentComposition("2034.28", [
        { amount: "2025.57" },
        { amount: "8.70" },
      ]),
    ).toBeNull();
    expect(
      validateAttachmentComposition("2034.28", [
        { amount: "2025.57" },
        { amount: "8.72" },
      ]),
    ).toBeNull();
  });
});
