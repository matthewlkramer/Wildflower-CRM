from pathlib import Path


path = Path(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx"
)
text = path.read_text()

old_import = '''import {
  accountingRecordIdentity,
  dedupeAccountingGroups,
  preferStagedAccountingRecords,
  singleAllocationPresentation,
} from "./presentation";
'''
new_import = '''import {
  accountingRecordIdentity,
  dedupeAccountingGroups,
  preferStagedAccountingRecords,
  singleAllocationPresentation,
  type DepositAccountingRecord,
} from "./presentation";
'''
if old_import not in text:
    raise SystemExit("presentation import block not found")
text = text.replace(old_import, new_import, 1)

old_label = '''function accountingLabel(record: WorkbenchDepositAccountingCheck | WorkbenchDepositQbRecord): string {
'''
new_label = '''function asQbDetailRecord(
  record: DepositAccountingRecord,
): Parameters<ClusterActions["openQbDetail"]>[0] {
  const role =
    record.role === "component" || record.role === "provisional"
      ? "anchor"
      : record.role;
  return { ...record, role } as Parameters<ClusterActions["openQbDetail"]>[0];
}

function accountingLabel(
  record:
    | DepositAccountingRecord
    | WorkbenchDepositAccountingCheck,
): string {
'''
if old_label not in text:
    raise SystemExit("accounting label function not found")
text = text.replace(old_label, new_label, 1)

text = text.replace(
    "actions.openQbDetail(firstRecord,",
    "actions.openQbDetail(asQbDetailRecord(firstRecord),",
    1,
)
text = text.replace(
    "record?.unconfirmed ?",
    'record && "unconfirmed" in record && record.unconfirmed ?',
    1,
)
old_detail = '''actions.openQbDetail(record ?? (display as WorkbenchDepositQbRecord), check ? "matched" : "missing")'''
new_detail = '''actions.openQbDetail(
                    record
                      ? asQbDetailRecord(record)
                      : (display as WorkbenchDepositQbRecord),
                    check ? "matched" : "missing",
                  )'''
if old_detail not in text:
    raise SystemExit("unaligned QBO detail action not found")
text = text.replace(old_detail, new_detail, 1)

path.write_text(text)
