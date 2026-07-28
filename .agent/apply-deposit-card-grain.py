from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} not found")
    return text.replace(old, new, 1)


rows_path = Path(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx"
)
rows = rows_path.read_text()

import_anchor = (
    'import type { EvidencePreview } from '
    '"@/components/reconciliation-clusters/dialogs";\n'
)
presentation_import = '''import {
  accountingRecordIdentity,
  dedupeAccountingGroups,
  preferStagedAccountingRecords,
  singleAllocationPresentation,
} from "./presentation";
'''
if presentation_import not in rows:
    rows = replace_once(
        rows,
        import_anchor,
        import_anchor + presentation_import,
        "rows import anchor",
    )

stripe_start = rows.index('  if (composition.kind === "stripe_payout") {')
stripe_end = rows.index(
    '  return (\n    <div className="space-y-1.5">', stripe_start
)
stripe_block = '''  if (composition.kind === "stripe_payout") {
    const refundTotal = Number(composition.refundTotal ?? 0);
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50/50 px-2.5 py-2 dark:border-emerald-900 dark:bg-emerald-950/30">
        <p className="text-xs font-semibold">
          Stripe payout · {money(composition.netTotal)} net
        </p>
        <p className="text-[11px] text-muted-foreground">
          {composition.payoutDate
            ? formatDateShort(composition.payoutDate)
            : "Undated"} · {composition.payoutId} · {composition.chargeCount ?? deposit.charges.length} charge{(composition.chargeCount ?? deposit.charges.length) === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
          Gross {money(composition.grossTotal)} − fees {money(composition.feeTotal)} − refunds {money(composition.refundTotal)} + adjustments {money(composition.adjustmentTotal)} = {money(composition.netTotal)} = bank {money(deposit.bank.amount)}
        </p>
        <div className="mt-2 space-y-1">
          {deposit.charges.map((charge) => {
            const refundedAmount = Number(charge.amountRefunded ?? 0);
            const laterRefunded = charge.refunded || refundedAmount > 0;
            const partialLaterRefund =
              laterRefunded &&
              refundedAmount > 0 &&
              refundedAmount < Number(charge.amount);
            return (
              <div
                key={charge.chargeId}
                className="flex items-center justify-between rounded border bg-background/80 px-2 py-1 text-[11px]"
              >
                <span className="truncate">
                  {charge.payerName ?? charge.chargeId}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="tabular-nums">{money(charge.amount)}</span>
                  {laterRefunded ? (
                    <Badge
                      variant="outline"
                      className="border-rose-300 text-[9px] text-rose-700 dark:border-rose-800 dark:text-rose-300"
                    >
                      Later refunded
                      {partialLaterRefund
                        ? ` · ${money(charge.amountRefunded)}`
                        : ""}
                    </Badge>
                  ) : null}
                  {charge.exclusionReason ? (
                    <Badge variant="destructive" className="text-[9px]">
                      Excluded
                    </Badge>
                  ) : null}
                  {actions.isFinanceOrAdmin ? (
                    <CardActionsMenu
                      items={[
                        {
                          label: "Exclude",
                          onSelect: () =>
                            actions.openExclude({
                              kind: "charge",
                              id: charge.chargeId,
                              label: charge.payerName ?? charge.chargeId,
                            }),
                        },
                        {
                          label: "Re-include",
                          onSelect: () =>
                            actions.reInclude({
                              kind: "charge",
                              id: charge.chargeId,
                              label: charge.payerName ?? charge.chargeId,
                            }),
                        },
                        ...(charge.refundKind
                          ? [
                              {
                                label: "Confirm refund",
                                onSelect: () =>
                                  actions.openConfirmRefund(
                                    charge.chargeId,
                                    charge.refundKind === "chargeback"
                                      ? "chargeback"
                                      : "refund",
                                    charge.payerName ?? charge.chargeId,
                                  ),
                              },
                              {
                                label: "Dismiss refund",
                                onSelect: () =>
                                  actions.openDismissRefund(
                                    charge.chargeId,
                                    charge.payerName ?? charge.chargeId,
                                  ),
                              },
                            ]
                          : []),
                      ]}
                    />
                  ) : null}
                </span>
              </div>
            );
          })}
          {refundTotal > 0 ? (
            <div className="flex items-center justify-between rounded border border-rose-200 bg-rose-50/50 px-2 py-1 text-[11px] text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
              <span className="truncate">Refunds settled in payout</span>
              <span className="tabular-nums">
                −{money(composition.refundTotal)}
              </span>
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          {composition.payoutAmbiguous ? (
            <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
              guessed match
            </span>
          ) : (
            <span />
          )}
          {actions.isFinanceOrAdmin && composition.payoutId ? (
            <CardActionsMenu
              items={[
                ...(composition.payoutAmbiguous
                  ? [
                      {
                        label: "Confirm match",
                        onSelect: () =>
                          actions.openConfirmPayoutBankMatch?.(
                            composition.payoutId ?? "",
                          ),
                      },
                    ]
                  : []),
                {
                  label: "Unlink deposit",
                  onSelect: () =>
                    actions.openUnlinkPayoutDeposit?.(
                      composition.payoutId ?? "",
                    ),
                },
                {
                  label: "Link to a different deposit…",
                  onSelect: () =>
                    actions.openLinkPayoutDeposit?.(
                      composition.payoutId ?? "",
                    ),
                },
                {
                  label: "Resolve payout settlement",
                  onSelect: () =>
                    actions.openSettlementSearch({
                      payoutId: composition.payoutId ?? "",
                      amount: deposit.bank.amount,
                      date: deposit.date ?? null,
                    }),
                },
              ]}
            />
          ) : null}
        </div>
      </div>
    );
  }
'''
rows = rows[:stripe_start] + stripe_block + rows[stripe_end:]

accounting_start = rows.index(
    '  const { accountingChecks: checks, qbRecords: records } = deposit;',
    rows.index("function Accounting("),
)
accounting_end = rows.index(
    "  const firstDisplay = firstRecord ?? checks[0];", accounting_start
)
accounting_block = '''  const { accountingChecks: checks, qbRecords: records } = deposit;
  const visibleRecords = preferStagedAccountingRecords(records);
  const checksByPayment = new Map(
    checks.map((check) => [check.stagedPaymentId, check]),
  );
  const items = [
    ...visibleRecords.map((record) => ({
      record,
      check: checksByPayment.get(record.stagedPaymentId),
    })),
    ...checks
      .filter(
        (check) =>
          !visibleRecords.some(
            (record) => record.stagedPaymentId === check.stagedPaymentId,
          ),
      )
      .map((check) => ({ record: undefined, check })),
  ];
  const nodeGroups = dedupeAccountingGroups([
    ...deposit.charges.map((charge) => ({
      key: `charge-${charge.chargeId}`,
      label: charge.payerName ?? charge.chargeId,
      records: charge.qboRecords ?? [],
    })),
    ...deposit.composition.components.map((component) => ({
      key: `component-${component.componentId}`,
      label: componentTitle(component),
      records: component.qboRecords ?? [],
    })),
    {
      key: "deposit",
      label: "Deposit accounting",
      records: visibleRecords.filter((record) => record.role === "deposit"),
    },
    ...deposit.gifts.map((gift) => ({
      key: `gift-${gift.giftId}`,
      label: gift.name ?? gift.giftId,
      records: gift.qboRecords ?? [],
    })),
  ]);
  const nodeRecordIds = new Set(
    nodeGroups.flatMap((group) =>
      group.records.map(accountingRecordIdentity),
    ),
  );
  const unalignedItems = items.filter(
    ({ record }) =>
      !record || !nodeRecordIds.has(accountingRecordIdentity(record)),
  );
  const firstRecord = visibleRecords[0];
'''
rows = rows[:accounting_start] + accounting_block + rows[accounting_end:]
rows = rows.replace(
    "disabled: !records.length && !checks.length",
    "disabled: !visibleRecords.length && !checks.length",
    1,
)

gift_anchor = "            const anchor = giftAnchor(gift);\n"
rows = replace_once(
    rows,
    gift_anchor,
    gift_anchor
    + "            const allocations = gift.allocations ?? [];\n"
    + "            const allocationPresentation = "
    + "singleAllocationPresentation(gift);\n",
    "gift renderer anchor",
)

alloc_start = rows.index(
    '              {(gift.allocations?.length ?? 0) > 0 ? ('
)
alloc_end_marker = '              ) : null}\n            </div>'
alloc_end = rows.index(alloc_end_marker, alloc_start) + len(
    '              ) : null}\n'
)
alloc_block = '''              {allocationPresentation.collapse ? (
                allocationPresentation.summary ? (
                  <p className="mt-1 whitespace-normal break-words text-[10px] text-muted-foreground">
                    {allocationPresentation.summary}
                  </p>
                ) : null
              ) : allocations.length > 0 ? (
                <div className="mt-1 space-y-1">
                  {allocations.map((allocation) => (
                    <div
                      key={allocation.id}
                      className="rounded border bg-muted/30 px-2 py-1"
                    >
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="truncate">
                          {allocation.usage ?? "No usage coded"}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {money(allocation.amount)}
                        </span>
                      </div>
                      {allocation.purpose ? (
                        <div className="whitespace-normal break-words text-[9px] text-muted-foreground">
                          {allocation.purpose}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
'''
rows = rows[:alloc_start] + alloc_block + rows[alloc_end:]
rows_path.write_text(rows)

api_path = Path(
    "artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts"
)
api = api_path.read_text()
old_where = '''          WHERE pa_u.gift_id IS NOT NULL AND (
            pa_u.id IN (SELECT c2.payment_unit_id FROM bank_deposit_components c2 WHERE c2.bank_deposit_id = d.id)
            OR (
              pa_u.stripe_charge_id IN (
                SELECT ch2.id
                FROM stripe_staged_charges ch2
                WHERE ch2.stripe_payout_id = p.id
                  AND ch2.raw_charge->>'status' = 'succeeded'
              )
            )
          )
'''
new_where = '''          WHERE pa_u.gift_id IS NOT NULL AND (
            (
              p.id IS NOT NULL
              AND pa_u.stripe_charge_id IN (
                SELECT ch2.id
                FROM stripe_staged_charges ch2
                WHERE ch2.stripe_payout_id = p.id
                  AND ch2.raw_charge->>'status' = 'succeeded'
              )
            )
            OR (
              (
                p.id IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM payment_units charge_gift_unit
                  JOIN stripe_staged_charges charge_gift
                    ON charge_gift.id = charge_gift_unit.stripe_charge_id
                  WHERE charge_gift.stripe_payout_id = p.id
                    AND charge_gift_unit.gift_id IS NOT NULL
                )
              )
              AND pa_u.id IN (
                SELECT c2.payment_unit_id
                FROM bank_deposit_components c2
                WHERE c2.bank_deposit_id = d.id
              )
            )
          )
'''
api = replace_once(api, old_where, new_where, "gift authority query")
api_path.write_text(api)

test_path = Path(
    "artifacts/api-server/src/__tests__/workbench-deposits.integration.test.ts"
)
test = test_path.read_text()
insert_before = (
    '  it("surfaces correction_needed accounting checks for component units", '
    "async () => {"
)
overlap_test = '''  it("prefers charge-grain gifts when a Stripe payout also carries a legacy component gift", async () => {
    const deposit = await seedDeposit("Stripe charge gift authority", "20.00");
    const payout = await seedPayout("20.00", deposit);
    const chargeGiftIds: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      const charge = await seedCharge(payout, { grossAmount: "5.00" });
      const giftId = nextId(`charge_gift_${index}`);
      const unitId = nextId(`charge_unit_${index}`);
      await db.insert(schema.giftsAndPayments).values({
        id: giftId,
        name: `Charge gift ${index + 1}`,
        amount: "5.00",
        dateReceived: "2099-12-31",
        organizationId: ORG_ID,
      });
      giftIds.push(giftId);
      chargeGiftIds.push(giftId);
      await db.insert(schema.paymentUnits).values({
        id: unitId,
        kind: "stripe_charge",
        stripeChargeId: charge,
        grossAmount: "5.00",
        feeAmount: "0.00",
        netAmount: "5.00",
        receivedDate: "2099-12-31",
        giftId,
        giftMatchMethod: "human",
      });
      unitIds.push(unitId);
    }

    const legacyGiftId = nextId("legacy_component_gift");
    const legacyUnitId = nextId("legacy_component_unit");
    const legacyComponentId = nextId("legacy_component");
    await db.insert(schema.giftsAndPayments).values({
      id: legacyGiftId,
      name: "Legacy payout-level gift",
      amount: "20.00",
      dateReceived: "2099-12-31",
      organizationId: ORG_ID,
    });
    giftIds.push(legacyGiftId);
    await db.insert(schema.paymentUnits).values({
      id: legacyUnitId,
      kind: "other",
      grossAmount: "20.00",
      netAmount: "20.00",
      receivedDate: "2099-12-31",
      giftId: legacyGiftId,
      giftMatchMethod: "human",
    });
    unitIds.push(legacyUnitId);
    await db.insert(schema.bankDepositComponents).values({
      id: legacyComponentId,
      bankDepositId: deposit,
      paymentUnitId: legacyUnitId,
      amount: "20.00",
      source: "manual",
    });
    componentIds.push(legacyComponentId);

    const result = await listDeposits(
      "completed",
      "Stripe charge gift authority",
    );
    const row = result.data.find((item: any) => item.anchorId === deposit);
    expect(row?.charges).toHaveLength(4);
    expect(row?.gifts.map((item: any) => item.giftId).sort()).toEqual(
      [...chargeGiftIds].sort(),
    );
    expect(
      row?.gifts.some((item: any) => item.giftId === legacyGiftId),
    ).toBe(false);
  });

'''
if overlap_test not in test:
    test = replace_once(
        test,
        insert_before,
        overlap_test + insert_before,
        "integration test insertion point",
    )
test_path.write_text(test)
