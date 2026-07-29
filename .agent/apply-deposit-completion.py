from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


rows_path = Path(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx"
)
rows = rows_path.read_text(encoding="utf-8")

rows = replace_once(
    rows,
    '''  accountingRecordIdentity,
  dedupeAccountingGroups,
  preferStagedAccountingRecords,
  singleAllocationPresentation,''',
    '''  accountingCorrectionPresentation,
  accountingRecordIdentity,
  dedupeAccountingGroups,
  preferStagedAccountingRecords,
  singleAllocationPresentation,''',
    "accounting correction helper import",
)

rows = replace_once(
    rows,
    '''function NodeQbCard({
  record,
  menuItems,
}: {
  record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord;
  menuItems?: Array<{''',
    '''function NodeQbCard({
  record,
  check,
  menuItems,
}: {
  record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord;
  check?: WorkbenchDepositAccountingCheck;
  menuItems?: Array<{''',
    "NodeQbCard correction prop",
)

rows = replace_once(
    rows,
    '''  const registerRecord =
    "bankTransactionId" in record && record.bankTransactionId ? record : null;
  return (''',
    '''  const registerRecord =
    "bankTransactionId" in record && record.bankTransactionId ? record : null;
  const correction = accountingCorrectionPresentation(check);
  return (''',
    "NodeQbCard correction projection",
)

rows = replace_once(
    rows,
    '''          <span className="text-[10px] tabular-nums">
            {money(record.amount)}
          </span>
          {menuItems?.length ? <CardActionsMenu items={menuItems} /> : null}''',
    '''          {correction ? (
            <Badge variant="destructive" className="text-[9px]">
              {correction.label}
            </Badge>
          ) : null}
          <span className="text-[10px] tabular-nums">
            {money(record.amount)}
          </span>
          {menuItems?.length ? <CardActionsMenu items={menuItems} /> : null}''',
    "nested correction badge",
)

rows = replace_once(
    rows,
    '''      {registerRecord ? (
        <div className="whitespace-normal break-words text-[9px] text-muted-foreground">''',
    '''      {correction ? (
        <div className="mt-1 whitespace-normal break-words text-[9px] font-medium text-destructive">
          {correction.note}
        </div>
      ) : null}
      {registerRecord ? (
        <div className="whitespace-normal break-words text-[9px] text-muted-foreground">''',
    "nested correction note",
)

rows = replace_once(
    rows,
    '''            <NodeQbCard
              key={`${record.role}-${record.stagedPaymentId}-${record.linkedChargeId ?? ""}`}
              record={record}
              menuItems={nodeMenuItems(record)}
            />''',
    '''            <NodeQbCard
              key={`${record.role}-${record.stagedPaymentId}-${record.linkedChargeId ?? ""}`}
              record={record}
              check={checksByPayment.get(record.stagedPaymentId)}
              menuItems={nodeMenuItems(record)}
            />''',
    "pass nested accounting check",
)

rows_path.write_text(rows, encoding="utf-8")
print("accounting blocker presentation patch applied")
