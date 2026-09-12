import { useMemo, useState } from "react";
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

  const monthlyParams: GetFundingArrivalsByMonthParams = useMemo(
    () => ({
      category,
      ...(globalEntityIds.length > 0
        ? { entityId: [...globalEntityIds].sort() }
        : {}),
    }),
    [globalEntityIds, category],
  );

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
            onClick={() => setCategory(c.value)}
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

      {monthlyParams && <MonthlyCashOutlook params={monthlyParams} />}
    </div>
  );
}

function MonthlyCashOutlook({
  params,
}: {
  params: GetFundingArrivalsByMonthParams;
}) {
  const query = useGetFundingArrivalsByMonth(params, {
    query: { queryKey: getGetFundingArrivalsByMonthQueryKey(params) },
  });

  if (query.isLoading) {
    return (
      <div className="mt-12 space-y-4">
        <SkeletonRows cols={4} />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="mt-12 text-destructive border-destructive border p-4 rounded-md">
        Failed to load monthly cash outlook:{" "}
        {query.error instanceof Error ? query.error.message : "Unknown error"}
      </div>
    );
  }

  if (!query.data) return null;

  const {
    months,
    actionableItems,
    unknownTiming,
    untimedReimbursementPlans,
  } = query.data;

  return (
    <section className="mt-12 space-y-6" data-testid="monthly-cash-outlook">
      <div>
        <h2 className="text-2xl font-serif font-bold text-foreground">
          Monthly cash outlook
        </h2>
        <p
          id="monthly-cash-outlook-description"
          className="text-sm text-muted-foreground mt-1"
        >
          Scheduled installments are reduced by recorded payments in oldest-due-first
          planning order, which is not evidence of a payment-to-installment match.
          Recipient filters select parent records with matching allocations; they do
          not split an installment between recipients.
        </p>
      </div>

      {months.length > 0 ? (
        <div className="rounded-md border bg-card overflow-x-auto">
          <Table aria-describedby="monthly-cash-outlook-description">
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Committed</TableHead>
                <TableHead className="text-right">Prospective</TableHead>
                <TableHead className="text-right">
                  Prospective (Weighted)
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((m) => (
                <TableRow key={m.month} data-testid={`row-monthly-${m.month}`}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {m.month}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(m.committedAmount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(m.prospectiveAmount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(m.prospectiveWeightedAmount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-md border bg-card p-6 text-center text-muted-foreground">
          No dated installments are recorded for the selected scope.
        </div>
      )}

      {actionableItems.length > 0 && (
        <div
          className="space-y-3 rounded-md border border-amber-300 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20"
          data-testid="monthly-actionable"
        >
          <h3 className="font-serif text-lg font-semibold">Needs attention</h3>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {actionableItems.map((item, i) => (
              <li
                key={`${item.opportunityId}-${i}`}
                className="rounded-md border bg-card p-2"
              >
                <Link
                  href={`/opportunities/${item.opportunityId}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {item.opportunityName ?? item.opportunityId}
                </Link>
                <div className="mt-1 text-xs text-muted-foreground">
                  <div>{item.message}</div>
                  <div className="mt-2">
                    <Link
                      href={`/opportunities/${item.opportunityId}`}
                      className="text-primary hover:underline"
                    >
                      Edit schedule
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {unknownTiming.length > 0 && (
        <div
          className="space-y-3 rounded-md border bg-card p-4"
          data-testid="monthly-unknown"
        >
          <h3 className="font-serif text-lg font-semibold">Unknown timing</h3>
          <p className="text-xs text-muted-foreground">
            These active commitments and open asks have no recorded payment dates.
          </p>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {unknownTiming.map((item, i) => (
              <li
                key={`${item.opportunityId}-${i}`}
                className="rounded-md border p-2"
              >
                <Link
                  href={`/opportunities/${item.opportunityId}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {item.opportunityName ?? item.opportunityId}
                </Link>
                <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                  <div>{item.message}</div>
                  <div className="flex justify-between">
                    <span>Remaining amount:</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(item.remainingAmount)}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Link
                      href={`/opportunities/${item.opportunityId}`}
                      className="text-primary hover:underline"
                    >
                      Edit schedule
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {untimedReimbursementPlans.length > 0 && (
        <div
          className="space-y-3 rounded-md border bg-card p-4"
          data-testid="monthly-reimbursement"
        >
          <h3 className="font-serif text-lg font-semibold">
            Untimed cost-reimbursement plans
          </h3>
          <p className="text-xs text-muted-foreground">
            These are annual planned amounts for cost-reimbursement awards, not
            cash forecasts or award ceilings. Only explicitly dated drawdowns appear
            above.
          </p>
          <ul className="mt-2 grid gap-2 md:grid-cols-2">
            {untimedReimbursementPlans.map((item, i) => (
              <li
                key={`${item.opportunityId}-${item.allocationId}-${i}`}
                className="rounded-md border p-2"
              >
                <Link
                  href={`/opportunities/${item.opportunityId}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {item.opportunityName ?? item.opportunityId}
                </Link>
                <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Planned annual amount:</span>
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(item.amount)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
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
