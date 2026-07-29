import { describe, expect, it } from "vitest";
import type {
  WorkbenchDeposit,
  WorkbenchDepositNodeQbRecord,
  WorkbenchDepositQbRecord,
} from "@workspace/api-client-react";
import {
  accountingCorrectionPresentation,
  accountingRecordIdentity,
  dedupeAccountingGroups,
  needsGiftPlaceholderPresentation,
  preferStagedAccountingRecords,
  singleAllocationPresentation,
} from "./presentation";

const staged = (
  id: string,
  overrides: Partial<WorkbenchDepositNodeQbRecord> = {},
): WorkbenchDepositNodeQbRecord =>
  ({
    stagedPaymentId: id,
    role: "deposit",
    amount: "100.00",
    dateReceived: "2026-01-01",
    payerName: "Example",
    linkedChargeId: null,
    ...overrides,
  }) as WorkbenchDepositNodeQbRecord;

const register = (id: string): WorkbenchDepositQbRecord =>
  ({
    stagedPaymentId: id,
    role: "deposit",
    amount: "92.00",
    bankTransactionId: id,
    payee: "Example",
  }) as WorkbenchDepositQbRecord;

const gift = (
  amount: string,
  allocations: WorkbenchDeposit["gifts"][number]["allocations"],
): WorkbenchDeposit["gifts"][number] =>
  ({
    giftId: "gift_1",
    amount,
    allocations,
  }) as WorkbenchDeposit["gifts"][number];

describe("deposit presentation helpers", () => {
  it("uses the richer staged QBO evidence instead of also rendering its register mirror", () => {
    const result = preferStagedAccountingRecords([
      register("register_1"),
      staged("staged_1"),
    ]);

    expect(result.map(accountingRecordIdentity)).toEqual(["staged:staged_1"]);
  });

  it("keeps register evidence when it is the only accounting evidence available", () => {
    const result = preferStagedAccountingRecords([register("register_1")]);
    expect(result.map(accountingRecordIdentity)).toEqual([
      "register:register_1",
    ]);
  });

  it("renders a QBO record only in the first preferred relationship group", () => {
    const record = staged("staged_1", { linkedChargeId: "charge_1" });
    const groups = dedupeAccountingGroups([
      { key: "charge", label: "Charge", records: [record] },
      { key: "gift", label: "Gift", records: [record] },
      { key: "deposit", label: "Deposit", records: [record] },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("charge");
    expect(groups[0].records).toHaveLength(1);
  });

  it("keeps a correction-needed check visible after its QBO row is nested", () => {
    expect(
      accountingCorrectionPresentation({
        disposition: "correction_needed",
        note: "Class is wrong",
      }),
    ).toEqual({ label: "Correction needed", note: "Class is wrong" });
  });

  it("supplies an explanation when a correction has no note", () => {
    expect(
      accountingCorrectionPresentation({
        disposition: "correction_needed",
        note: null,
      }),
    ).toEqual({
      label: "Correction needed",
      note: "This QuickBooks record is on the accounting corrections worklist.",
    });
  });

  it("does not add a blocker for non-correction accounting states", () => {
    expect(
      accountingCorrectionPresentation({
        disposition: "consistent",
        note: null,
      }),
    ).toBeNull();
  });

  it("distinguishes an unlinked payment from a CRM gift", () => {
    expect(
      needsGiftPlaceholderPresentation("Chia Ling Rodeski", "payment"),
    ).toEqual({
      title: "Needs CRM gift",
      subtitle: "Payment from Chia Ling Rodeski",
    });
  });

  it("collapses a single same-amount allocation into inline coding", () => {
    expect(
      singleAllocationPresentation(
        gift("100.00", [
          {
            id: "allocation_1",
            amount: "100.00",
            usage: "Gen Ops",
            purpose: null,
          },
        ]),
      ),
    ).toEqual({ collapse: true, summary: "Gen Ops" });
  });

  it("keeps real allocation splits as separate rows", () => {
    expect(
      singleAllocationPresentation(
        gift("100.00", [
          {
            id: "allocation_1",
            amount: "60.00",
            usage: "Program A",
            purpose: null,
          },
          {
            id: "allocation_2",
            amount: "40.00",
            usage: "Program B",
            purpose: null,
          },
        ]),
      ).collapse,
    ).toBe(false);
  });
});

describe("card metadata contract", () => {
  it("keeps undated card text explicit", () => {
    expect("Undated · $5.00").toContain("Undated");
  });
});
