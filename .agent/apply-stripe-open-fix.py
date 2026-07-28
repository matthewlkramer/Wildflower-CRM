from pathlib import Path

# 1. Stripe payout completion: charge-grain gift ties are authoritative.
route_path = Path("artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts")
route = route_path.read_text()
old_component_need = """        OR COALESCE(bool_or(c.id IS NOT NULL AND c.exclusion_reason IS NULL AND NOT EXISTS (
        SELECT 1 FROM payment_units pu
        WHERE pu.id = c.payment_unit_id
          AND pu.gift_id IS NOT NULL
      )), false)
"""
new_component_need = """        OR (
          p.id IS NULL
          AND COALESCE(bool_or(c.id IS NOT NULL AND c.exclusion_reason IS NULL AND NOT EXISTS (
            SELECT 1 FROM payment_units pu
            WHERE pu.id = c.payment_unit_id
              AND pu.gift_id IS NOT NULL
          )), false)
        )
"""
if old_component_need not in route:
    raise SystemExit("component needs-gift block not found")
route_path.write_text(route.replace(old_component_need, new_component_need, 1))

# 2. Gifts column: QBO records are accounting evidence, never CRM gift cards.
rows_path = Path("artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx")
rows = rows_path.read_text()
qb_preview_start = rows.index("function qbPreview(")
deposit_row_start = rows.index("export function DepositRow", qb_preview_start)
rows = rows[:qb_preview_start] + rows[deposit_row_start:]

segment_start = rows.index("  const linkedStagedPaymentIds =")
segment_end = rows.index("  const giftAnchor =", segment_start)
replacement = '''  const giftColumnAnchor: AnchorRef | null = (() => {
    const charge = deposit.charges.find((item) => !item.linkedGiftId);
    if (charge) {
      return {
        kind: "charge",
        id: charge.chargeId,
        label: charge.payerName ?? charge.chargeId,
      };
    }
    const component =
      deposit.composition.kind === "components"
        ? deposit.composition.components.find(
            (item) =>
              (item.countedGiftIds?.length ?? 0) === 0 &&
              Boolean(item.stagedPaymentId),
          )
        : undefined;
    if (component?.stagedPaymentId) {
      return {
        kind: "staged",
        id: component.stagedPaymentId,
        label: component.label ?? component.kind,
      };
    }
    return null;
  })();
  const bankPreview: EvidencePreview = {
    amount: money(deposit.bank.amount),
    date: deposit.date ? formatDateShort(deposit.date) : "—",
    method: "Bank deposit",
    source: deposit.bank.memo ?? deposit.bank.reference ?? deposit.anchorId,
    memo: deposit.bank.memo ?? null,
  };
  const unlinkedCharges = deposit.charges.filter(
    (charge) => !charge.linkedGiftId,
  );
  const unlinkedComponents =
    deposit.composition.kind === "components"
      ? deposit.composition.components.filter(
          (component) =>
            component.source === "bank_spine" &&
            (component.countedGiftIds?.length ?? 0) === 0 &&
            component.stagedPaymentId,
        )
      : [];
  const hasGiftColumnCards =
    deposit.gifts.length > 0 ||
    unlinkedCharges.length > 0 ||
    unlinkedComponents.length > 0;
'''
rows = rows[:segment_start] + replacement + rows[segment_end:]

qb_cards_start = rows.find("          {unlinkedQbRecords.map((record) => {")
if qb_cards_start < 0:
    raise SystemExit("unlinked QBO gift-card block not found")
components_start = rows.find(
    "          {unlinkedComponents.map((component) => {", qb_cards_start
)
if components_start < 0:
    raise SystemExit("unlinked component block not found")
rows = rows[:qb_cards_start] + rows[components_start:]
rows_path.write_text(rows)

# 3. Recent-actions empty state should describe the reversible rail.
page_path = Path("artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx")
page = page_path.read_text()
old_empty = "No reconciliation actions recorded yet."
new_empty = "No reversible reconciliation actions recorded yet."
if old_empty not in page:
    raise SystemExit("recent actions empty-state text not found")
page_path.write_text(page.replace(old_empty, new_empty, 1))

# 4. Regression coverage for a fee-net Stripe deposit with redundant QBO component.
test_path = Path("artifacts/api-server/src/__tests__/workbench-deposits.integration.test.ts")
test = test_path.read_text()
insert_before = '  it("prefers charge-grain gifts when a Stripe payout also carries a legacy component gift", async () => {'
if insert_before not in test:
    raise SystemExit("deposit integration insertion anchor not found")
new_test = '''  it("does not keep a fully linked Stripe payout open because of a gift-less accounting component", async () => {
    const deposit = await seedDeposit(
      "Stripe fee-net payout with QBO evidence",
      "142.00",
    );
    const payout = await seedPayout("142.00", deposit);
    await db
      .update(schema.stripePayouts)
      .set({ grossTotal: "150.00", feeTotal: "8.00", netTotal: "142.00" })
      .where(eqFn(schema.stripePayouts.id, payout));
    const charge = await seedCharge(payout, { grossAmount: "150.00" });
    const giftId = nextId("fee_net_gift");
    const chargeUnitId = nextId("fee_net_charge_unit");
    await db.insert(schema.giftsAndPayments).values({
      id: giftId,
      name: "Fee-net Stripe gift",
      amount: "150.00",
      dateReceived: "2099-12-31",
      organizationId: ORG_ID,
    });
    giftIds.push(giftId);
    await db.insert(schema.paymentUnits).values({
      id: chargeUnitId,
      kind: "stripe_charge",
      stripeChargeId: charge,
      grossAmount: "150.00",
      feeAmount: "8.00",
      netAmount: "142.00",
      receivedDate: "2099-12-31",
      giftId,
      giftMatchMethod: "human",
    });
    unitIds.push(chargeUnitId);

    // This is downstream accounting evidence, not a second donor payment.
    await seedUnit(deposit, "142.00");

    const completed = await listDeposits(
      "completed",
      "Stripe fee-net payout with QBO evidence",
    );
    const row = completed.data.find((item: any) => item.anchorId === deposit);
    expect(row?.lenses).toContain("completed");
    expect(row?.lenses).not.toContain("needs_gift");
    expect(row?.charges).toHaveLength(1);
    expect(row?.gifts.map((item: any) => item.giftId)).toEqual([giftId]);

    const open = await listDeposits(
      "all_open",
      "Stripe fee-net payout with QBO evidence",
    );
    expect(open.data.some((item: any) => item.anchorId === deposit)).toBe(false);
  });

'''
test_path.write_text(test.replace(insert_before, new_test + insert_before, 1))
