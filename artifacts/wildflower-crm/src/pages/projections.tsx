import { Fragment, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetProjectionsByFyEntity,
  useGetFundingArrivalsByMonth,
  useListEntities,
  useListFiscalYears,
  getGetProjectionsByFyEntityQueryKey,
  getGetFundingArrivalsByMonthQueryKey,
  getListEntitiesQueryKey,
  getListFiscalYearsQueryKey,
  type FundingArrivalItem,
  type FundraisingCategory,
  type ProjectionByFyEntityRow,
  type ProjectionCombinedFyRow,
  type ProjectionForecastDiagnostic,
  type GetFundingArrivalsByMonthParams,
} from "@workspace/api-client-react";
import {
  currentFiscalYearEndYear,
  currentFiscalYearSlug,
  formatCurrency,
  formatDate,
} from "@/lib/format";
import { useEntityFilter } from "@/lib/entity-filter-context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkeletonRows } from "@/components/ui/skeleton";

const UNKNOWN_BUCKET = "__unknown__";
type ProjectionCombinedForecastRow = ProjectionCombinedFyRow;

export default function Projections() {
  const { selected: globalEntityIds } = useEntityFilter();
  const [category, setCategory] = useState<FundraisingCategory>("revenue");
  const projParams = useMemo(
    () =>
      globalEntityIds.length > 0 || category
        ? {
            ...(globalEntityIds.length > 0
              ? { entityId: [...globalEntityIds].sort() }
              : {}),
            category,
          }
        : undefined,
    [globalEntityIds, category],
  );
  const proj = useGetProjectionsByFyEntity(projParams, {
    query: { queryKey: getGetProjectionsByFyEntityQueryKey(projParams) },
  });

  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey() },
  });
  const fyQ = useListFiscalYears(undefined, {
    query: { queryKey: getListFiscalYearsQueryKey() },
  });

  const { fyRows, entityCols, cell } = useMemo(() => {
    const rows = (proj.data?.rows ?? []).filter((r) => r.category === category);
    const fySeen = new Set<string>();
    const entSeen = new Set<string>();
    const cell = new Map<string, ProjectionByFyEntityRow>();
    for (const row of rows) {
      const fy = row.grantYear ?? UNKNOWN_BUCKET;
      const ent = row.entityId ?? UNKNOWN_BUCKET;
      fySeen.add(fy);
      entSeen.add(ent);
      cell.set(`${fy}|${ent}`, row);
    }
    const currentFy = currentFiscalYearSlug();
    const nextFy = `fy${currentFiscalYearEndYear() + 1}`;
    const fiscalYearEnd = (id: string) => {
      const year = Number(id.match(/\d{4}/)?.[0]);
      return Number.isFinite(year) ? year : -Infinity;
    };
    const fyRows = Array.from(fySeen).sort((a, b) => {
      const priority = (id: string) =>
        id === currentFy
          ? 0
          : id === nextFy
            ? 1
            : id === UNKNOWN_BUCKET
              ? 3
              : 2;
      const priorityDifference = priority(a) - priority(b);
      if (priorityDifference !== 0) return priorityDifference;
      if (a === UNKNOWN_BUCKET || b === UNKNOWN_BUCKET) return 0;
      return fiscalYearEnd(b) - fiscalYearEnd(a) || a.localeCompare(b);
    });
    const entityById = new Map(
      (entitiesQ.data ?? []).map((e) => [e.id, e.name] as const),
    );
    const entityCols = Array.from(entSeen).sort((a, b) => {
      if (a === UNKNOWN_BUCKET && b !== UNKNOWN_BUCKET) return 1;
      if (b === UNKNOWN_BUCKET && a !== UNKNOWN_BUCKET) return -1;
      const na = entityById.get(a) ?? a;
      const nb = entityById.get(b) ?? b;
      return na.localeCompare(nb);
    });
    return { fyRows, entityCols, cell };
  }, [proj.data, entitiesQ.data, category]);

  const combinedRows = useMemo(
    () =>
      (proj.data?.combinedRows ?? []).filter(
        (row) => row.category === category,
      ),
    [proj.data?.combinedRows, category],
  );

  const entityName = (id: string) => {
    if (id === UNKNOWN_BUCKET) return "Unknown recipient";
    const name = (entitiesQ.data ?? []).find((e) => e.id === id)?.name;
    return name ?? `Unknown recipient (${id})`;
  };
  const fyLabel = (id: string) => {
    if (id === UNKNOWN_BUCKET) return "Unknown fiscal year";
    const label = (fyQ.data ?? []).find((f) => f.id === id)?.label;
    return label ?? `Unknown fiscal year (${id})`;
  };

  const isLoading = proj.isLoading;
  const isError = proj.isError;
  const error = proj.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Projections
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Plan expected fundraising by fiscal year and recipient. The forecast
          separates grants and revenue from loan capital, keeps historical years
          visible, and clearly identifies unknown information.
        </p>
      </div>

      <FundingCategoryToggle category={category} onChange={setCategory} />

      <ForecastTotals
        rows={combinedRows}
        fiscalYears={fyQ.data ?? []}
        category={category}
      />

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fiscal year</TableHead>
              {entityCols.map((e) => (
                <TableHead key={e} className="whitespace-nowrap">
                  {entityName(e)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={Math.max(entityCols.length + 1, 2)} />
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={Math.max(entityCols.length + 1, 2)}
                  className="text-center h-24 text-destructive"
                >
                  {error instanceof Error
                    ? error.message
                    : "Failed to load projections."}
                </TableCell>
              </TableRow>
            ) : fyRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={Math.max(entityCols.length + 1, 2)}
                  className="text-center h-24 text-muted-foreground"
                >
                  No forecast information is available.
                </TableCell>
              </TableRow>
            ) : (
              <>
                {fyRows.map((fy) => {
                  return (
                    <TableRow key={fy} data-testid={`row-projection-${fy}`}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {fyLabel(fy)}
                      </TableCell>
                      {entityCols.map((ent) => {
                        const row = cell.get(`${fy}|${ent}`);
                        return (
                          <TableCell
                            key={ent}
                            className="align-top"
                            data-testid={`cell-${fy}-${ent}`}
                          >
                            {row ? <ProjectionCell row={row} /> : "—"}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </>
            )}
          </TableBody>
        </Table>
      </div>
      {entityCols.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Recipient comparisons are useful for context, but they may not add up
          to the total because payment credit is capped once per opportunity
          within the selected recipient scope.
        </p>
      ) : null}
      <ForecastOmissions diagnostics={proj.data?.diagnostics ?? []} />
    </div>
  );
}

export function CashFlow() {
  const { selected: globalEntityIds } = useEntityFilter();
  const [category, setCategory] = useState<FundraisingCategory>("revenue");
  const params: GetFundingArrivalsByMonthParams = useMemo(
    () => ({
      category,
      ...(globalEntityIds.length > 0
        ? { entityId: [...globalEntityIds].sort() }
        : {}),
    }),
    [globalEntityIds, category],
  );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Cash flow
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          See when committed and prospective funding is expected to arrive.
        </p>
      </div>
      <FundingCategoryToggle category={category} onChange={setCategory} />
      <MonthlyCashOutlook params={params} />
    </div>
  );
}

function FundingCategoryToggle({
  category,
  onChange,
}: {
  category: FundraisingCategory;
  onChange: (category: FundraisingCategory) => void;
}) {
  return (
    <div
      className="flex items-center gap-1"
      data-testid="projections-category-toggle"
    >
      {[
        { value: "revenue" as const, label: "Grants / Revenue" },
        { value: "loan_capital" as const, label: "Loans / Loan Capital" },
      ].map((c) => (
        <button
          key={c.value}
          type="button"
          data-testid={`projections-category-${c.value}`}
          aria-pressed={category === c.value}
          onClick={() => onChange(c.value)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            category === c.value
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/70"
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

const basisLabels = {
  projected_close: "Projected close date",
  explicit_payment: "Explicit payment date",
  unscheduled: "Timing not estimated",
  reimbursement_annual: "Annual reimbursement plan",
};
const money = (amount: string | null) =>
  amount == null ? "Unknown" : formatCurrency(amount);
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T12:00:00Z`));

function MonthlyCashOutlook({
  params,
}: {
  params: GetFundingArrivalsByMonthParams;
}) {
  const [status, setStatus] = useState("all");
  const [basis, setBasis] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const query = useGetFundingArrivalsByMonth(params, {
    query: { queryKey: getGetFundingArrivalsByMonthQueryKey(params) },
  });
  if (query.isLoading) return <SkeletonRows cols={5} />;
  if (query.isError)
    return (
      <p role="alert" className="text-destructive">
        Could not load expected arrivals.{" "}
        {query.error instanceof Error
          ? query.error.message
          : "Please try again."}
      </p>
    );
  if (!query.data) return null;
  const { items, asOfDate } = query.data;
  const filtered = items.filter(
    (item) =>
      (status === "all" || item.status === status) &&
      (basis === "all" || item.basis === basis),
  );
  const currentMonth = asOfDate.slice(0, 7);
  const [year, month] = currentMonth.split("-").map(Number);
  const months = Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(year, month - 1 + index, 1)).toISOString().slice(0, 7),
  );
  const dated = filtered.filter(
    (item) => item.expectedDate && item.basis !== "reimbursement_annual",
  );
  const older = dated.filter(
    (item) => item.expectedDate!.slice(0, 7) < currentMonth,
  );
  const later = dated.filter(
    (item) => item.expectedDate!.slice(0, 7) > months[11],
  );
  const undated = filtered.filter(
    (item) => !item.expectedDate && item.basis !== "reimbursement_annual",
  );
  const annual = filtered.filter(
    (item) => item.basis === "reimbursement_annual",
  );
  const toggle = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const groups = months.map((key) => ({
    key,
    label: monthLabel(key),
    items: dated.filter((item) => item.expectedDate!.startsWith(key)),
  }));
  return (
    <section className="space-y-5" data-testid="monthly-cash-outlook">
      <div>
        <h2 className="text-2xl font-serif font-bold">
          Expected funding arrivals
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          One-time pipeline gifts default to their projected close date. An
          explicit payment plan overrides that estimate. Prospective amounts are
          weighted by the existing opportunity probability. Payment dates are
          optional.
        </p>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="grid gap-1 text-sm">
          Funding status
          <select
            aria-label="Funding status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-md border bg-background px-3 py-2"
          >
            <option value="all">Committed and prospective</option>
            <option value="pledge">Committed only</option>
            <option value="open">Prospective only</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Timing basis
          <select
            aria-label="Timing basis"
            value={basis}
            onChange={(event) => setBasis(event.target.value)}
            className="rounded-md border bg-background px-3 py-2"
          >
            <option value="all">All timing sources</option>
            <option value="projected_close">Estimated from close date</option>
            <option value="explicit_payment">Explicit payment date</option>
            <option value="unscheduled">Timing not estimated</option>
            <option value="reimbursement_annual">
              Annual reimbursement plan
            </option>
          </select>
        </label>
        {status !== "all" || basis !== "all" ? (
          <button
            type="button"
            className="self-end rounded-md border px-3 py-2 text-sm"
            onClick={() => {
              setStatus("all");
              setBasis("all");
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <div>
        <h3 className="font-serif text-lg font-semibold">
          Next 12 months · {monthLabel(currentMonth)} – {monthLabel(months[11])}
        </h3>
        <p
          className="text-xs text-muted-foreground mt-1"
          id="monthly-cash-outlook-description"
        >
          Includes the current month, based on the report date of{" "}
          {formatDate(asOfDate)}. Expand a month to see its expectations. Totals
          reflect the filters above and include only known amounts; unknown
          amounts and probabilities remain visible in the details.
        </p>
      </div>
      {filtered.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No funding records match these filters.
        </p>
      ) : null}
      <div className="rounded-md border bg-card overflow-x-auto">
        <Table
          aria-label="Monthly expected arrivals"
          aria-describedby="monthly-cash-outlook-description"
        >
          <TableHeader>
            <TableRow>
              <TableHead>Expected month</TableHead>
              <TableHead className="text-right">Committed</TableHead>
              <TableHead className="text-right">Prospective</TableHead>
              <TableHead className="text-right">
                Prospective, weighted
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <Fragment key={group.key}>
                <TableRow data-testid={`row-monthly-${group.key}`}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left font-medium hover:underline disabled:text-muted-foreground disabled:no-underline"
                      aria-expanded={expanded.has(group.key)}
                      aria-controls={`arrival-details-${group.key}`}
                      disabled={group.items.length === 0}
                      onClick={() => toggle(group.key)}
                    >
                      {expanded.has(group.key) ? "▾" : "▸"} {group.label}{" "}
                      <span className="text-xs text-muted-foreground">
                        ({group.items.length} expectations)
                      </span>
                    </button>
                  </TableCell>
                  <ArrivalTotalCells items={group.items} />
                </TableRow>
                {expanded.has(group.key) && group.items.length > 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      id={`arrival-details-${group.key}`}
                      className="p-3 bg-muted/20"
                    >
                      <ArrivalDetails
                        items={group.items}
                        label={`${group.label} funding details`}
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      <ArrivalGroup
        groupKey="older"
        title="Earlier outstanding amounts"
        description={`Expected before ${monthLabel(currentMonth)}. Original dates are retained; these amounts are not moved into the next 12 months.`}
        items={older}
      />
      <ArrivalGroup
        groupKey="later"
        title="Beyond the next 12 months"
        description={`Expected after ${monthLabel(months[11])}.`}
        items={later}
      />
      <ArrivalGroup
        groupKey="undated"
        title="Timing not estimated"
        description="These records have no receipt date. Payment dates remain optional, and these amounts are not included in monthly totals."
        items={undated}
      />
      <ArrivalGroup
        groupKey="annual"
        title="Annual reimbursement plans"
        description="Gross annual plan context only; these amounts are not additional remaining cash and are excluded from receipt totals."
        items={annual}
        contextOnly
      />
      <p className="text-xs text-muted-foreground">
        Recorded payments cover the oldest installments first for planning; this
        does not establish individual payment matches. Recipient filters select
        whole records with matching allocations, so amounts may also cover other
        recipients. Do not add separate recipient views together.
      </p>
    </section>
  );
}

// Sum the server's remaining and weighted amounts; never rederive probability,
// payment coverage, writeoffs, or receipt dates in the browser.
function ArrivalTotalCells({ items }: { items: FundingArrivalItem[] }) {
  const sum = (status: FundingArrivalItem["status"], weighted = false) => {
    const matching = items.filter((item) => item.status === status);
    const values = matching.map((item) =>
      weighted ? item.weightedAmount : item.amount,
    );
    const total =
      values.reduce<number>(
        (sum, value) =>
          sum + (value == null ? 0 : Math.round(Number(value) * 100)),
        0,
      ) / 100;
    return (
      <TableCell className="text-right tabular-nums">
        {formatCurrency(total)}
        {values.some((value) => value == null) ? (
          <span className="block text-xs text-muted-foreground">
            Plus unknown amounts
          </span>
        ) : null}
      </TableCell>
    );
  };
  return (
    <>
      {sum("pledge")}
      {sum("open")}
      {sum("open", true)}
    </>
  );
}

function ArrivalGroup({
  groupKey,
  title,
  description,
  items,
  contextOnly = false,
}: {
  groupKey: string;
  title: string;
  description: string;
  items: FundingArrivalItem[];
  contextOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <section
      className="rounded-md border bg-card p-4 space-y-3"
      data-testid={`arrival-group-${groupKey}`}
    >
      <h3>
        <button
          type="button"
          className="font-serif text-lg font-semibold hover:underline"
          aria-expanded={open}
          aria-controls={`arrival-group-details-${groupKey}`}
          onClick={() => setOpen((previous) => !previous)}
        >
          {open ? "▾" : "▸"} {title} ({items.length} expectations)
        </button>
      </h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      {!contextOnly ? (
        <div className="overflow-x-auto">
          <Table aria-label={`${title} totals`}>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Prospective</TableHead>
                <TableHead className="text-right">
                  Prospective, weighted
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <ArrivalTotalCells items={items} />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      ) : null}
      {open ? (
        <div
          id={`arrival-group-details-${groupKey}`}
          className="overflow-x-auto"
        >
          <ArrivalDetails items={items} label={`${title} details`} />
        </div>
      ) : null}
    </section>
  );
}

function ArrivalDetails({
  items,
  label,
}: {
  items: FundingArrivalItem[];
  label: string;
}) {
  return (
    <div className="rounded-md border bg-card overflow-x-auto">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>Opportunity / pledge</TableHead>
            <TableHead>Expected receipt</TableHead>
            <TableHead>Timing basis</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="text-right">Weighted amount</TableHead>
            <TableHead>Notes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length ? (
            items.map((item) => (
              <TableRow key={item.id} data-testid={`arrival-${item.id}`}>
                <TableCell className="min-w-48">
                  <Link
                    className="font-medium hover:underline"
                    href={`/opportunities/${item.opportunityId}#payment-plan`}
                  >
                    {item.opportunityName ?? "Unnamed opportunity"}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {item.status === "pledge" ? "Committed" : "Prospective"}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {item.expectedDate
                    ? formatDate(item.expectedDate)
                    : "Not estimated"}
                </TableCell>
                <TableCell>{basisLabels[item.basis]}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {money(item.amount)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.basis === "reimbursement_annual"
                    ? "Not included"
                    : money(item.weightedAmount)}
                </TableCell>
                <TableCell className="min-w-64 text-xs text-muted-foreground">
                  {item.overdue && (
                    <strong className="block text-amber-700 dark:text-amber-400">
                      Overdue expected payment
                    </strong>
                  )}
                  {item.note}
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={6}
                className="text-center text-muted-foreground"
              >
                No active funding records in this scope.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function ProjectionCell({ row }: { row: ProjectionByFyEntityRow }) {
  const money = (value: string | null | undefined) =>
    value == null ? "—" : formatCurrency(value);
  return (
    <div className="min-w-[15rem] space-y-1 text-right text-xs tabular-nums">
      <ProjectionValue
        label="Received goal credit"
        value={money(row.receivedGoalCredit)}
      />
      <ProjectionValue
        label="Face-value unpaid commitments"
        value={money(row.unpaidCommitment)}
      />
      <ProjectionValue
        label="Probability-weighted unpaid commitments"
        value={money(row.unpaidCommitmentWeighted)}
      />
      <ProjectionValue
        label="Probability-weighted open asks"
        value={money(row.openAskWeighted)}
      />
      <ProjectionValue label="Goal" value={money(row.goal)} />
      <ProjectionValue label="Goal gap" value={money(row.goalGap)} />
    </div>
  );
}

function ProjectionValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-left text-muted-foreground">{label}</span>
      <span className="shrink-0 font-medium text-foreground">{value}</span>
    </div>
  );
}

function forecastTotal(row: ProjectionCombinedForecastRow): string {
  if (row.weightedProjection == null) return "—";
  const amount = Number(row.weightedProjection);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

function ForecastTotals({
  rows,
  fiscalYears,
  category,
}: {
  rows: ProjectionCombinedForecastRow[];
  fiscalYears: { id: string; label: string }[];
  category: FundraisingCategory;
}) {
  const currentFy = currentFiscalYearSlug();
  const nextFy = `fy${currentFiscalYearEndYear() + 1}`;
  const rowByYear = new Map(rows.map((row) => [row.grantYear, row]));
  const fiscalYearLabel = (id: string | null) => {
    if (id == null) return "Unknown fiscal year";
    return (
      fiscalYears.find((fiscalYear) => fiscalYear.id === id)?.label ??
      `Unknown fiscal year (${id})`
    );
  };
  const orderedRows = [currentFy, nextFy]
    .map((year) => rowByYear.get(year))
    .filter((row): row is ProjectionCombinedFyRow => row != null);
  if (orderedRows.length === 0) return null;

  return (
    <section
      className="space-y-3 rounded-md border bg-card p-4"
      data-testid="projection-total-forecast"
    >
      <div>
        <h2 className="font-serif text-lg font-semibold">
          Total forecast for selected recipients —{" "}
          {category === "revenue" ? "Grants / Revenue" : "Loans / Loan Capital"}
        </h2>
        <p className="text-xs text-muted-foreground">
          These totals are the authoritative forecast for the selected recipient
          scope. Each opportunity contributes payment credit only once.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {orderedRows.map((row) => (
          <div
            key={row.grantYear}
            className="rounded-md border p-3"
            data-testid={`projection-total-${row.grantYear}`}
          >
            <h3 className="mb-2 font-medium">
              {fiscalYearLabel(row.grantYear)}
            </h3>
            <div className="space-y-1 text-right text-xs tabular-nums">
              <div data-testid="projection-total-amount">
                <ProjectionValue
                  label="Total forecast"
                  value={forecastTotal(row)}
                />
              </div>
              <ProjectionValue
                label="Received goal credit"
                value={formatCurrency(row.receivedGoalCredit)}
              />
              <ProjectionValue
                label="Face-value unpaid commitments"
                value={formatCurrency(row.unpaidCommitment)}
              />
              <ProjectionValue
                label="Probability-weighted unpaid commitments"
                value={formatCurrency(row.unpaidCommitmentWeighted)}
              />
              <ProjectionValue
                label="Probability-weighted open asks"
                value={formatCurrency(row.openAskWeighted)}
              />
              <ProjectionValue
                label="Goal"
                value={row.goal == null ? "—" : formatCurrency(row.goal)}
              />
              <ProjectionValue
                label="Goal gap"
                value={row.goalGap == null ? "—" : formatCurrency(row.goalGap)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const OMISSION_REASON_LABELS: Record<string, string> = {
  missing_amount: "Amount is missing",
  missing_fiscal_year: "Fiscal year is missing",
  missing_recipient: "Recipient is missing",
  missing_reimbursement_type: "Reimbursement type is missing",
  no_allocations: "No forecast information is recorded",
  unused_capacity: "Cost-reimbursement unused capacity",
  direct_reimbursement_excluded:
    "Direct reimbursement is excluded from the forecast",
  zero_weight_early_prospect:
    "Early prospect has zero probability (weighted amount is $0)",
};

const NEEDS_ATTENTION_REASONS = new Set([
  "missing_amount",
  "missing_fiscal_year",
  "missing_recipient",
  "missing_reimbursement_type",
  "no_allocations",
]);

const INFORMATION_REASONS = new Set([
  "unused_capacity",
  "direct_reimbursement_excluded",
  "zero_weight_early_prospect",
]);

function ForecastOmissions({
  diagnostics,
}: {
  diagnostics: ProjectionForecastDiagnostic[];
}) {
  if (diagnostics.length === 0) return null;
  const needsAttention = diagnostics.filter((diagnostic) =>
    diagnostic.reasons.some((reason) => NEEDS_ATTENTION_REASONS.has(reason)),
  );
  const information = diagnostics.filter((diagnostic) =>
    diagnostic.reasons.some((reason) => INFORMATION_REASONS.has(reason)),
  );
  const renderDiagnostic = (diagnostic: ProjectionForecastDiagnostic) => (
    <li
      key={`${diagnostic.opportunityId}-${diagnostic.allocationId ?? "opportunity"}`}
      className="rounded-md border p-2"
    >
      <Link
        href={`/opportunities/${diagnostic.opportunityId}`}
        className="font-medium text-foreground hover:underline"
      >
        {diagnostic.opportunityName ?? diagnostic.opportunityId}
      </Link>
      <div className="mt-1 text-xs text-muted-foreground">
        {diagnostic.message ? <div>{diagnostic.message}</div> : null}
        <div>
          {diagnostic.reasons
            .map(
              (reason) =>
                OMISSION_REASON_LABELS[reason] ?? "Additional forecast detail",
            )
            .join("; ")}
        </div>
      </div>
    </li>
  );
  return (
    <section
      className="space-y-3 rounded-md border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20"
      data-testid="projection-omissions"
    >
      <div>
        {needsAttention.length > 0 ? (
          <div data-testid="projection-needs-attention">
            <h2 className="font-serif text-lg font-semibold">
              Needs attention
            </h2>
            <p className="text-xs text-muted-foreground">
              These records are missing details needed to place them in a
              forecast. A known-year amount with an unknown recipient can still
              count in the all-recipients total.
            </p>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {needsAttention.map(renderDiagnostic)}
            </ul>
          </div>
        ) : null}
        {information.length > 0 ? (
          <div
            className={
              needsAttention.length > 0
                ? "border-t border-amber-300 pt-3 dark:border-amber-900"
                : undefined
            }
            data-testid="projection-information"
          >
            <h2 className="font-serif text-lg font-semibold">Information</h2>
            <p className="text-xs text-muted-foreground">
              These notes explain forecast treatment. A known-year amount with
              an unknown recipient can still count in the all-recipients total.
            </p>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {information.map(renderDiagnostic)}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
