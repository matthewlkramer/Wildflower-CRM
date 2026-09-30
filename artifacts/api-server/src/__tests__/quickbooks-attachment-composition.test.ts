import { describe, expect, it } from "vitest";
import {
  chooseAttachmentComposition,
  normalizeAttachmentComponents,
  validateAttachmentComposition,
} from "../lib/quickbooksAttachmentComposition";

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

  it("combines two distinct check attachments only when their sum is exact", () => {
    const village = normalizeAttachmentComponents("2034.28", [
      {
        amount: "2025.57",
        payerName: "Village Montessori",
        checkNumber: "1842",
      },
    ]);
    const other = normalizeAttachmentComponents("2034.28", [
      { amount: "8.71", payerName: "Other payer", checkNumber: "991" },
    ]);
    expect(village).not.toBeNull();
    expect(other).not.toBeNull();
    expect(
      chooseAttachmentComposition("2034.28", [
        { attachmentId: "village", components: village! },
        { attachmentId: "other", components: other! },
      ]),
    ).toHaveLength(2);
    expect(
      chooseAttachmentComposition("2034.29", [
        { attachmentId: "village", components: village! },
        { attachmentId: "other", components: other! },
      ]),
    ).toBeNull();
  });

  it("rejects duplicate scans and conflicting full-deposit interpretations", () => {
    const check = normalizeAttachmentComponents("2000", [
      { amount: "1000", payerName: "Same donor", checkNumber: "42" },
    ])!;
    expect(
      chooseAttachmentComposition("2000", [
        { attachmentId: "front", components: check },
        { attachmentId: "back", components: check },
      ]),
    ).toBeNull();
    const first = validateAttachmentComposition("2000", [
      { amount: "1000", payerName: "A" },
      { amount: "1000", payerName: "B" },
    ])!;
    const second = validateAttachmentComposition("2000", [
      { amount: "1500", payerName: "A" },
      { amount: "500", payerName: "B" },
    ])!;
    expect(
      chooseAttachmentComposition("2000", [
        { attachmentId: "slip-a", components: first },
        { attachmentId: "slip-b", components: second },
      ]),
    ).toBeNull();
  });
});
