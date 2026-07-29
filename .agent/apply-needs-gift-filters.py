from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def save(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Pure presentation helper + tests
# ---------------------------------------------------------------------------
presentation_path = Path(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/presentation.ts"
)
presentation = presentation_path.read_text(encoding="utf-8")
anchor = "export type SingleAllocationPresentation = {\n"
helper = '''export type NeedsGiftPlaceholderPresentation = {
  title: "Needs CRM gift";
  subtitle: string;
};

/** Keep an unlinked payment from looking like an actual CRM gift card. */
export function needsGiftPlaceholderPresentation(
  payerName: string | null | undefined,
  fallback: string,
): NeedsGiftPlaceholderPresentation {
  const payer = payerName?.trim() || fallback;
  return {
    title: "Needs CRM gift",
    subtitle: `Payment from ${payer}`,
  };
}

'''
if helper.strip() not in presentation:
    presentation = replace_once(
        presentation,
        anchor,
        helper + anchor,
        "needs-gift presentation helper",
    )
save(presentation_path, presentation)

test_path = Path(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/presentation.test.ts"
)
test = test_path.read_text(encoding="utf-8")
test = replace_once(
    test,
    '''  dedupeAccountingGroups,
  preferStagedAccountingRecords,
  singleAllocationPresentation,''',
    '''  dedupeAccountingGroups,
  needsGiftPlaceholderPresentation,
  preferStagedAccountingRecords,
  singleAllocationPresentation,''',
    "presentation test import",
)
placeholder_test = '''
  it("distinguishes an unlinked payment from a CRM gift", () => {
    expect(needsGiftPlaceholderPresentation("Chia Ling Rodeski", "payment")).toEqual({
      title: "Needs CRM gift",
      subtitle: "Payment from Chia Ling Rodeski",
    });
  });
'''
if placeholder_test.strip() not in test:
    marker = '  it("collapses a single same-amount allocation into inline coding", () => {'
    test = replace_once(
        test,
        marker,
        placeholder_test + "\n" + marker,
        "placeholder presentation test",
    )
save(test_path, test)


# ---------------------------------------------------------------------------
# Gifts-column placeholder cards
# ---------------------------------------------------------------------------
rows_path = Path(
    "artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx"
)
rows = rows_path.read_text(encoding="utf-8")
rows = replace_once(
    rows,
    '''  accountingRecordIdentity,
  dedupeAccountingGroups,
  preferStagedAccountingRecords,''',
    '''  accountingRecordIdentity,
  dedupeAccountingGroups,
  needsGiftPlaceholderPresentation,
  preferStagedAccountingRecords,''',
    "rows presentation import",
)
rows = replace_once(
    rows,
    '''          {unlinkedCharges.map((charge) => {
            const anchor: AnchorRef = {''',
    '''          {unlinkedCharges.map((charge) => {
            const placeholder = needsGiftPlaceholderPresentation(
              charge.payerName,
              charge.chargeId,
            );
            const anchor: AnchorRef = {''',
    "charge placeholder variable",
)
rows = replace_once(
    rows,
    '''                className="rounded-md border border-dashed bg-card px-2.5 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-[11px] font-medium">
                    {charge.payerName ?? charge.chargeId}
                  </p>
                  <CardActionsMenu''',
    '''                className="rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-1.5 dark:border-amber-800 dark:bg-amber-950/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                      {placeholder.title}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {placeholder.subtitle}
                    </p>
                  </div>
                  <CardActionsMenu''',
    "charge placeholder card",
)
rows = replace_once(
    rows,
    '''          {unlinkedComponents.map((component) => {
            const anchor: AnchorRef = {''',
    '''          {unlinkedComponents.map((component) => {
            const placeholder = needsGiftPlaceholderPresentation(
              component.label,
              componentTitle(component),
            );
            const anchor: AnchorRef = {''',
    "component placeholder variable",
)
rows = replace_once(
    rows,
    '''                className="rounded-md border border-dashed bg-card px-2.5 py-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-[11px] font-medium">
                    {componentTitle(component)}
                  </p>
                  <CardActionsMenu''',
    '''                className="rounded-md border border-dashed border-amber-300 bg-amber-50/60 px-2.5 py-1.5 dark:border-amber-800 dark:bg-amber-950/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                      {placeholder.title}
                    </p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {placeholder.subtitle}
                    </p>
                  </div>
                  <CardActionsMenu''',
    "component placeholder card",
)
# Component placeholder metadata must include both date and amount, like every card.
rows = replace_once(
    rows,
    '''                <p className="text-[11px] tabular-nums text-muted-foreground">
                  {money(component.amount)}
                </p>''',
    '''                <p className="text-[11px] tabular-nums text-muted-foreground">
                  {component.receivedDate
                    ? formatDateShort(component.receivedDate)
                    : "Undated"}{" "}
                  · {money(component.amount)}
                </p>''',
    "component placeholder metadata",
)
save(rows_path, rows)


# ---------------------------------------------------------------------------
# Candidate payment API: optional exact amount and date filters
# ---------------------------------------------------------------------------
route_path = Path(
    "artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts"
)
route = route_path.read_text(encoding="utf-8")
route = replace_once(
    route,
    '''    const targetAmount = query.amount ? Number(query.amount) : remainder;
    const search = query.q?.trim() || null;''',
    '''    const targetAmount = query.amount ? Number(query.amount) : remainder;
    const search = query.q?.trim() || null;
    const rawFilterAmount =
      typeof req.query.filterAmount === "string"
        ? req.query.filterAmount.trim()
        : "";
    const filterAmount = rawFilterAmount ? Number(rawFilterAmount) : null;
    if (
      filterAmount !== null &&
      (!Number.isFinite(filterAmount) || filterAmount < 0)
    ) {
      res.status(400).json({
        error: "validation_error",
        message: "Amount filter must be a non-negative number.",
      });
      return;
    }
    const filterDate =
      typeof req.query.filterDate === "string" && req.query.filterDate.trim()
        ? req.query.filterDate.trim()
        : null;
    if (filterDate) {
      const parsed = new Date(`${filterDate}T00:00:00Z`);
      if (
        !/^\\d{4}-\\d{2}-\\d{2}$/.test(filterDate) ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== filterDate
      ) {
        res.status(400).json({
          error: "validation_error",
          message: "Date filter must be a valid YYYY-MM-DD date.",
        });
        return;
      }
    }''',
    "candidate filter parsing",
)
route = replace_once(
    route,
    '''        AND COALESCE(u.gross_amount, u.net_amount) IS NOT NULL
        AND (
          ${search}::text IS NULL''',
    '''        AND COALESCE(u.gross_amount, u.net_amount) IS NOT NULL
        AND (
          ${filterAmount}::numeric IS NULL
          OR abs(COALESCE(u.gross_amount, u.net_amount) - ${filterAmount}::numeric) < 0.005
        )
        AND (${filterDate}::date IS NULL OR u.received_date = ${filterDate}::date)
        AND (
          ${search}::text IS NULL''',
    "candidate SQL filters",
)
save(route_path, route)


# ---------------------------------------------------------------------------
# Candidate payment dialog: exact amount/date controls
# ---------------------------------------------------------------------------
page_path = Path("artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx")
page = page_path.read_text(encoding="utf-8")
page = replace_once(
    page,
    '''  const [knownPaymentSearch, setKnownPaymentSearch] = useState("");''',
    '''  const [knownPaymentSearch, setKnownPaymentSearch] = useState("");
  const [knownPaymentFilterAmount, setKnownPaymentFilterAmount] = useState("");
  const [knownPaymentFilterDate, setKnownPaymentFilterDate] = useState("");''',
    "known payment filter state",
)
old_params = '''    {
      amount: knownPaymentFor?.remainder,
      q: knownPaymentSearch.trim() || undefined,
      limit: 25,
    },'''
new_params = '''    ({
      amount: knownPaymentFor?.remainder,
      q: knownPaymentSearch.trim() || undefined,
      filterAmount: knownPaymentFilterAmount.trim() || undefined,
      filterDate: knownPaymentFilterDate || undefined,
      limit: 100,
    } as any),'''
count = page.count(old_params)
if count != 1:
    raise SystemExit(f"candidate hook params: expected one occurrence, found {count}")
page = page.replace(old_params, new_params, 1)
old_key_params = '''          {
            amount: knownPaymentFor?.remainder,
            q: knownPaymentSearch.trim() || undefined,
            limit: 25,
          },'''
new_key_params = '''          ({
            amount: knownPaymentFor?.remainder,
            q: knownPaymentSearch.trim() || undefined,
            filterAmount: knownPaymentFilterAmount.trim() || undefined,
            filterDate: knownPaymentFilterDate || undefined,
            limit: 100,
          } as any),'''
count = page.count(old_key_params)
if count != 1:
    raise SystemExit(f"candidate query-key params: expected one occurrence, found {count}")
page = page.replace(old_key_params, new_key_params, 1)

# Reset filters whenever the dialog/search state is reset.
page = page.replace(
    'setKnownPaymentSearch("");',
    'setKnownPaymentSearch("");\n      setKnownPaymentFilterAmount("");\n      setKnownPaymentFilterDate("");',
)

# Insert controls immediately after the search input. Locate structurally instead
# of depending on surrounding formatting.
search_value = "value={knownPaymentSearch}"
value_index = page.find(search_value)
if value_index < 0:
    raise SystemExit("known payment search input not found")
input_start = page.rfind("<Input", 0, value_index)
input_end = page.find("/>", value_index)
if input_start < 0 or input_end < 0:
    raise SystemExit("known payment search input boundaries not found")
input_end += 2
filters_markup = '''
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">Amount</span>
                    <Input
                      value={knownPaymentFilterAmount}
                      onChange={(event) =>
                        setKnownPaymentFilterAmount(event.target.value)
                      }
                      inputMode="decimal"
                      placeholder="Any amount"
                      aria-label="Filter payments by amount"
                    />
                  </label>
                  <label className="space-y-1 text-xs">
                    <span className="font-medium">Date</span>
                    <Input
                      type="date"
                      value={knownPaymentFilterDate}
                      onChange={(event) =>
                        setKnownPaymentFilterDate(event.target.value)
                      }
                      aria-label="Filter payments by date"
                    />
                  </label>
                </div>'''
if "Filter payments by amount" not in page:
    page = page[:input_end] + filters_markup + page[input_end:]

for old_empty in [
    "No unclaimed payment units near this remainder.",
    "No payment units match this search.",
    "No payment units found.",
]:
    if old_empty in page:
        page = page.replace(
            old_empty,
            "No payment units match this search and filters.",
        )

save(page_path, page)


# ---------------------------------------------------------------------------
# API integration coverage
# ---------------------------------------------------------------------------
integration_path = Path(
    "artifacts/api-server/src/__tests__/workbench-deposits.integration.test.ts"
)
integration = integration_path.read_text(encoding="utf-8")
filter_test = r'''

  it("filters known-payment candidates by exact amount and date", async () => {
    const depositId = await seedDeposit("Candidate filter target", "9999.00");
    const matchingId = nextId("filter_matching_unit");
    const wrongAmountId = nextId("filter_wrong_amount_unit");
    const wrongDateId = nextId("filter_wrong_date_unit");

    await db.insert(schema.paymentUnits).values([
      {
        id: matchingId,
        kind: "check",
        grossAmount: "9876.54",
        netAmount: "9876.54",
        receivedDate: "2098-04-03",
      },
      {
        id: wrongAmountId,
        kind: "check",
        grossAmount: "9876.55",
        netAmount: "9876.55",
        receivedDate: "2098-04-03",
      },
      {
        id: wrongDateId,
        kind: "check",
        grossAmount: "9876.54",
        netAmount: "9876.54",
        receivedDate: "2098-04-04",
      },
    ]);
    unitIds.push(matchingId, wrongAmountId, wrongDateId);

    const filtered = await getJson(
      `/api/reconciliation/deposits/${depositId}/candidate-payment-units?filterAmount=9876.54&filterDate=2098-04-03&limit=100`,
    );
    expect(filtered.status).toBe(200);
    const ids = filtered.json.data.map((item: { id: string }) => item.id);
    expect(ids).toContain(matchingId);
    expect(ids).not.toContain(wrongAmountId);
    expect(ids).not.toContain(wrongDateId);

    const badAmount = await getJson(
      `/api/reconciliation/deposits/${depositId}/candidate-payment-units?filterAmount=not-money`,
    );
    expect(badAmount.status).toBe(400);

    const badDate = await getJson(
      `/api/reconciliation/deposits/${depositId}/candidate-payment-units?filterDate=2098-99-99`,
    );
    expect(badDate.status).toBe(400);
  });
'''
if filter_test.strip() not in integration:
    if not integration.endswith("\n});\n"):
        raise SystemExit("deposit integration test final closure not found")
    integration = integration[:-5] + filter_test + "\n});\n"
save(integration_path, integration)

print("needs-gift placeholders and payment filters applied")
