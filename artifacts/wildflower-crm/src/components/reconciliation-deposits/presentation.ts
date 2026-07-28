import type {
  WorkbenchDeposit,
  WorkbenchDepositNodeQbRecord,
  WorkbenchDepositQbRecord,
} from "@workspace/api-client-react";

export type DepositAccountingRecord =
  | WorkbenchDepositNodeQbRecord
  | WorkbenchDepositQbRecord;

export type DepositAccountingGroup = {
  key: string;
  label: string;
  records: DepositAccountingRecord[];
};

function isRegisterRecord(record: DepositAccountingRecord): boolean {
  return "bankTransactionId" in record && Boolean(record.bankTransactionId);
}

/**
 * The QBO register mirror is fallback evidence. Once a richer staged QBO record
 * is available for the row, rendering both presents one accounting transaction
 * twice under slightly different names and amounts.
 */
export function preferStagedAccountingRecords(
  records: DepositAccountingRecord[],
): DepositAccountingRecord[] {
  return records.some((record) => !isRegisterRecord(record))
    ? records.filter((record) => !isRegisterRecord(record))
    : records;
}

/** One QuickBooks source row should render once even when several relationships
 * (charge, gift, component, deposit) all point at it. Group order establishes
 * the preferred display location. */
export function accountingRecordIdentity(
  record: DepositAccountingRecord,
): string {
  if (isRegisterRecord(record)) {
    return `register:${String(
      (record as WorkbenchDepositQbRecord).bankTransactionId,
    )}`;
  }
  return `staged:${record.stagedPaymentId}`;
}

export function dedupeAccountingGroups(
  groups: DepositAccountingGroup[],
): DepositAccountingGroup[] {
  const seen = new Set<string>();
  return groups
    .map((group) => ({
      ...group,
      records: group.records.filter((record) => {
        const identity = accountingRecordIdentity(record);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      }),
    }))
    .filter((group) => group.records.length > 0);
}

export type SingleAllocationPresentation = {
  collapse: boolean;
  summary: string | null;
};

/**
 * A one-line allocation that equals the gift amount is the gift's coding, not a
 * second money card. Multiple allocations or a differing amount remain visible
 * as rows because they carry real split information.
 */
export function singleAllocationPresentation(
  gift: WorkbenchDeposit["gifts"][number],
): SingleAllocationPresentation {
  const allocations = gift.allocations ?? [];
  if (allocations.length !== 1) return { collapse: false, summary: null };

  const allocation = allocations[0];
  const giftAmount = Number(gift.amount);
  const allocationAmount = Number(allocation.amount);
  if (
    !Number.isFinite(giftAmount) ||
    !Number.isFinite(allocationAmount) ||
    Math.abs(giftAmount - allocationAmount) >= 0.005
  ) {
    return { collapse: false, summary: null };
  }

  const summary = [allocation.usage, allocation.purpose]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" · ");
  return { collapse: true, summary: summary || null };
}
