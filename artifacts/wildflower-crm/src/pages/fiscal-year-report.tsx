import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearch, useLocation } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useGetFiscalYearReport,
  useListFiscalYears,
  getGetFiscalYearReportQueryKey,
  getListFiscalYearsQueryKey,
  type FiscalYearReportRow,
  type FundraisingCategory,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort, formatEnum, abbreviateUsStates, currentFiscalYearSlug } from "@/lib/format";
import { partitionFiscalYears } from "@/lib/dropdownVisibility";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkeletonRows } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DonorCell } from "@/components/donor-cell";
import { useEntityFilter } from "@/lib/entity-filter-context";

const CATEGORY_LABELS: Record<FundraisingCategory, string> = {
  revenue: "Grants / Revenue",
  loan_capital: "Loans / Loan Capital",
};

const CATEGORY_OPTIONS: { value: FundraisingCategory; label: string }[] = [
  { value: "revenue", label: "Grants" },
  { value: "loan_capital", label: "Loans" },
];

function parseCategory(s: string | null): FundraisingCategory {
  if (s === "revenue" || s === "loan_capital") return s;
  return "revenue";
}

function fmt(s: string | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  return formatCurrency(s);
}

function pct(s: string | null | undefined): string {
  if (s === null || s === undefined || s === "") return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

function fmtDate(s: string | null | undefined): string {
  return formatDateShort(s);
}

// Wildflower fiscal year: July 1 – June 30, labelled by the END year, in
// America/Chicago (mirrors the server's computeCurrentFiscalYear). Used to
// resolve the `current` URL alias to a concrete `fy<endYear>` slug. The
// actual FY decision lives in the shared helper (lib/format).

export default function FiscalYearReport() {
  const params = useParams<{ fyId: string }>();
  const fyId = params.fyId;
  const [, navigate] = useLocation();
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const category = parseCategory(sp.get("category"));

  // The nav links to `/fiscal-year-report/current`; resolve that alias to a
  // concrete `fy<endYear>` slug so the URL is shareable and the query has a
  // real FY id. Done in an effect (redirect) rather than inline so the slug
  // shows in the address bar.
  const isAlias = fyId === "current";
  useEffect(() => {
    if (isAlias) {
      const next = new URLSearchParams(search);
      next.set("category", category);
      navigate(`/fiscal-year-report/${currentFiscalYearSlug()}?${next.toString()}`, { replace: true });
    }
  }, [isAlias, search, category, navigate]);

  // Entity scope is sourced from the global header filter — the exact same
  // source the dashboard bar uses — so this report reconciles to the bar for
  // any number of selected entities (none = all entities).
  const { selected: selectedEntityIds } = useEntityFilter();
  const entityIds = selectedEntityIds.length > 0 ? selectedEntityIds : undefined;

  const reportParams = useMemo(
    () => ({ category, ...(entityIds ? { entityIds } : {}) }),
    [category, entityIds],
  );
  const reportQ = useGetFiscalYearReport(fyId, reportParams, {
    query: {
      queryKey: getGetFiscalYearReportQueryKey(fyId, reportParams),
      enabled: Boolean(fyId) && !isAlias,
      // A transient auth/DB hiccup (surfaced as a 5xx) should self-recover
      // rather than break the page. Retry server/network failures a few times
      // with backoff, but never retry a 4xx — those won't fix themselves.
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | null | undefined)?.status;
        if (status != null && status >= 400 && status < 500) return false;
        return failureCount < 3;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
  });
  const fyListQ = useListFiscalYears(undefined, {
    query: { queryKey: getListFiscalYearsQueryKey(), staleTime: 5 * 60_000 },
  });

  const data = reportQ.data;
  const rows = data?.rows ?? [];
  const totals = data?.totals;

  const receivedRows = useMemo(() => rows.filter((r) => r.bucket === "received"), [rows]);
  const committedRows = useMemo(() => rows.filter((r) => r.bucket === "committed"), [rows]);
  const openRows = useMemo(() => rows.filter((r) => r.bucket === "open"), [rows]);

  const fyOptions = useMemo(() => {
    const list = (fyListQ.data ?? []).map((f) => ({ id: f.id, label: f.label }));
    list.sort((a, b) => b.id.localeCompare(a.id));
    return list;
  }, [fyListQ.data]);

  const { recent: recentFyOptions, older: olderFyOptions } = useMemo(
    () => partitionFiscalYears(fyOptions),
    [fyOptions],
  );
  const fyHidden = olderFyOptions.some((f) => f.id === fyId);
  const [showAllFy, setShowAllFy] = useState(false);
  const effectiveShowAllFy = showAllFy || fyHidden;
  const visibleFyOptions = effectiveShowAllFy
    ? [...recentFyOptions, ...olderFyOptions]
    : recentFyOptions;

  const setFy = (newFyId: string) => {
    if (newFyId === fyId) return;
    const next = new URLSearchParams(search);
    next.set("category", category);
    navigate(`/fiscal-year-report/${newFyId}?${next.toString()}`);
  };
  const setCategory = (c: FundraisingCategory) => {
    if (c === category) return;
    const next = new URLSearchParams(search);
    next.set("category", c);
    navigate(`/fiscal-year-report/${fyId}?${next.toString()}`, { replace: true });
  };

  const fyLabel = data?.fiscalYear.label ?? fyId;

  // The header reproduces the dashboard "Progress to goal" bar: the three
  // segments (Received, Committed-weighted, Weighted open) sum to the weighted
  // projection, measured against the goal. Same numbers, same order.
  const received = Number(totals?.received ?? 0);
  const committedWeighted = Number(totals?.committedWeighted ?? 0);
  const openWeighted = Number(totals?.openWeighted ?? 0);
  const projection = Number(totals?.weightedProjection ?? 0);
  const goalNum = totals?.goal != null && Number(totals.goal) > 0 ? Number(totals.goal) : null;
  const hasGoal = goalNum != null;
  const overGoal = hasGoal && projection > goalNum;
  const coverage = hasGoal ? projection / goalNum! : null;

  // A hard error with no data to fall back on: show a calm, retryable state
  // instead of a red "HTTP 500" banner layered over misleading $0 tiles.
  // While a retry is in flight we keep the loading affordances rather than the
  // error card so the page doesn't flash between states.
  const showError = reportQ.isError && !reportQ.isFetching && !data;

  const entityScopeNote =
    selectedEntityIds.length === 0
      ? "all entities"
      : selectedEntityIds.length === 1
        ? "1 entity"
        : `${selectedEntityIds.length} entities`;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-muted-foreground">
          <Link href="/dashboard" className="hover:underline">Dashboard</Link>
          <span className="mx-1">/</span>
          <span>FY report</span>
        </div>
        <h1 className="text-3xl font-serif font-bold text-foreground mt-1">
          {fyLabel} · {CATEGORY_LABELS[category]}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every record behind this fiscal year's progress-to-goal calculation —
          received gifts, committed pledges, and the weighted open pipeline.
          Totals reconcile to the dashboard bar. Scoped to{" "}
          <span className="font-medium">{entityScopeNote}</span> (change in the
          header filter).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1" data-testid="report-category-toggle">
          {CATEGORY_OPTIONS.map((c) => (
            <button
              key={c.value}
              type="button"
              data-testid={`report-category-${c.value}`}
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

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Fiscal year
          </label>
          <div className="flex flex-col items-start gap-0.5">
            <Select value={fyId} onValueChange={setFy}>
              <SelectTrigger className="w-40" data-testid="select-fy">
                <SelectValue placeholder={fyId} />
              </SelectTrigger>
              <SelectContent>
                {visibleFyOptions.map((f) => (
                  <SelectItem key={f.id} value={f.id} data-testid={`select-fy-option-${f.id}`}>
                    {f.label}
                  </SelectItem>
                ))}
                {!fyOptions.find((f) => f.id === fyId) && fyId ? (
                  <SelectItem value={fyId}>{fyLabel}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {olderFyOptions.length > 0 && !fyHidden ? (
              <button
                type="button"
                data-testid="select-fy-toggle"
                onClick={() => setShowAllFy((s) => !s)}
                className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline px-1"
              >
                {effectiveShowAllFy
                  ? "Show recent fiscal years only"
                  : `Show all fiscal years (+${olderFyOptions.length})`}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {showError ? (
        <Card data-testid="report-error">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm font-medium text-foreground">
              We couldn't load this report just now.
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              This is usually a brief connection hiccup — nothing is lost. Try
              again in a moment.
            </p>
            <button
              type="button"
              data-testid="report-retry"
              onClick={() => reportQ.refetch()}
              disabled={reportQ.isFetching}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {reportQ.isFetching ? "Retrying…" : "Try again"}
            </button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Reconciling header — mirrors the dashboard progress bar. */}
          <Card data-testid="report-summary">
            <CardHeader className="pb-3">
              <div className="flex items-baseline justify-between gap-4">
                <CardTitle className="text-lg">Progress to goal</CardTitle>
                <div className="text-sm text-right" data-testid="report-summary-total">
                  {reportQ.isLoading ? (
                    <span className="text-muted-foreground">…</span>
                  ) : hasGoal ? (
                    <span>
                      <span className="font-semibold text-foreground">{formatCurrency(projection)}</span>
                      <span className="text-muted-foreground"> of {formatCurrency(goalNum!)} goal</span>
                      <span className="ml-2 font-medium text-foreground">{Math.round(coverage! * 100)}%</span>
                      {overGoal ? (
                        <span className="ml-1 text-emerald-600">(+{formatCurrency(projection - goalNum!)} over)</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      <span className="font-semibold text-foreground">{formatCurrency(projection)}</span>{" "}
                      projected · No goal set
                    </span>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <SummaryTile label="Received" value={formatCurrency(received)} testId="tile-received" />
                <SummaryTile label="Committed (weighted)" value={formatCurrency(committedWeighted)} testId="tile-committed" />
                <SummaryTile label="Weighted open pipeline" value={formatCurrency(openWeighted)} testId="tile-open" />
                <SummaryTile label="Goal" value={fmt(totals?.goal ?? null)} testId="tile-goal" />
              </div>
            </CardContent>
          </Card>

          <ReceivedTable
            rows={receivedRows}
            total={totals?.received ?? "0"}
            isLoading={reportQ.isLoading}
          />
          <CommittedTable
            rows={committedRows}
            totalAmount={totals?.committed ?? "0"}
            totalWeighted={totals?.committedWeighted ?? "0"}
            isLoading={reportQ.isLoading}
          />
          <OpenTable
            rows={openRows}
            totalAsk={totals?.openAsk ?? "0"}
            totalWeighted={totals?.openWeighted ?? "0"}
            isLoading={reportQ.isLoading}
          />
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-serif font-bold text-foreground">{value}</p>
      </CardContent>
    </Card>
  );
}

function BucketHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="text-lg font-serif font-semibold text-foreground">{title}</h2>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </div>
  );
}

function ReceivedTable({
  rows, total, isLoading,
}: { rows: FiscalYearReportRow[]; total: string; isLoading: boolean }) {
  const ts = useTableState("fy-report-received", { key: "amount", dir: "desc" });
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          dateReceived: (r) => r.dateReceived ?? null,
          donor: (r) =>
            (r.organizationName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
          usage: (r) => r.displayUsage?.toLowerCase() ?? null,
          amount: (r) => (r.amount != null ? Number(r.amount) : null),
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );
  return (
    <div className="space-y-2" data-testid="report-bucket-received">
      <BucketHeading title="Received" subtitle="Cash in — gift allocations booked to this fiscal year." />
      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="dateReceived" {...ts}>Date received</SortableTH>
              <SortableTH colKey="donor" {...ts}>Donor</SortableTH>
              <SortableTH colKey="usage" {...ts}>Usage</SortableTH>
              <SortableTH colKey="amount" align="right" {...ts}>Amount</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={4} />
            ) : sortedRows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center h-24 text-muted-foreground">No gifts received in this fiscal year + track.</TableCell></TableRow>
            ) : (
              <>
                {sortedRows.map((r) => (
                  <TableRow key={r.rowId} data-testid={`row-${r.rowId}`}>
                    <TableCell className="whitespace-nowrap">
                      <Link href={`/gifts/${r.giftId}`} className="hover:underline">
                        {fmtDate(r.dateReceived)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <DonorCell
                        organizationId={r.organizationId}
                        organizationName={r.organizationName}
                        organizationPriority={r.organizationPriority}
                        householdId={r.householdId}
                        householdName={r.householdName}
                        individualGiverPersonId={r.individualGiverPersonId}
                        individualGiverPersonName={r.individualGiverPersonName}
                        individualGiverPersonPriority={r.individualGiverPersonPriority}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.displayUsage ? abbreviateUsStates(r.displayUsage) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{fmt(r.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30 font-medium">
                  <TableCell colSpan={3}>Total received</TableCell>
                  <TableCell className="text-right tabular-nums" data-testid="row-received-total">{fmt(total)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CommittedTable({
  rows, totalAmount, totalWeighted, isLoading,
}: {
  rows: FiscalYearReportRow[];
  totalAmount: string;
  totalWeighted: string;
  isLoading: boolean;
}) {
  const ts = useTableState("fy-report-committed", { key: "amount", dir: "desc" });
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          donor: (r) =>
            (r.organizationName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
          opportunity: (r) => (r.opportunityName ?? r.opportunityId ?? "").toLowerCase(),
          pledged: (r) => (r.pledgedAmount != null ? Number(r.pledgedAmount) : null),
          paid: (r) => (r.paidAmount != null ? Number(r.paidAmount) : null),
          winProb: (r) => (r.winProbability != null ? Number(r.winProbability) : null),
          amount: (r) => (r.amount != null ? Number(r.amount) : null),
          weighted: (r) => (r.weightedAmount != null ? Number(r.weightedAmount) : null),
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );
  return (
    <div className="space-y-2" data-testid="report-bucket-committed">
      <BucketHeading title="Committed" subtitle="Unpaid remainder of written pledges (pledged − paid this FY)." />
      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="donor" {...ts}>Donor</SortableTH>
              <SortableTH colKey="opportunity" {...ts}>Opportunity</SortableTH>
              <SortableTH colKey="pledged" align="right" {...ts}>Pledged</SortableTH>
              <SortableTH colKey="paid" align="right" {...ts}>Paid</SortableTH>
              <SortableTH colKey="winProb" align="right" {...ts}>Win prob</SortableTH>
              <SortableTH colKey="amount" align="right" {...ts}>Remainder</SortableTH>
              <SortableTH colKey="weighted" align="right" {...ts}>Weighted</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={7} />
            ) : sortedRows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">No committed pledges in this fiscal year + track.</TableCell></TableRow>
            ) : (
              <>
                {sortedRows.map((r) => (
                  <TableRow key={r.rowId} data-testid={`row-${r.rowId}`}>
                    <TableCell>
                      <DonorCell
                        organizationId={r.organizationId}
                        organizationName={r.organizationName}
                        organizationPriority={r.organizationPriority}
                        householdId={r.householdId}
                        householdName={r.householdName}
                        individualGiverPersonId={r.individualGiverPersonId}
                        individualGiverPersonName={r.individualGiverPersonName}
                        individualGiverPersonPriority={r.individualGiverPersonPriority}
                      />
                    </TableCell>
                    <TableCell>
                      <Link href={`/opportunities/${r.opportunityId}`} className="hover:underline">
                        {r.opportunityName ?? r.opportunityId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmt(r.pledgedAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmt(r.paidAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(r.winProbability)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{fmt(r.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.weightedAmount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30 font-medium">
                  <TableCell colSpan={5}>Total committed</TableCell>
                  <TableCell className="text-right tabular-nums" data-testid="row-committed-total">{fmt(totalAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums" data-testid="row-committed-total-weighted">{fmt(totalWeighted)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function OpenTable({
  rows, totalAsk, totalWeighted, isLoading,
}: {
  rows: FiscalYearReportRow[];
  totalAsk: string;
  totalWeighted: string;
  isLoading: boolean;
}) {
  const ts = useTableState("fy-report-open", { key: "amount", dir: "desc" });
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          projectedClose: (r) => r.projectedCloseDate ?? null,
          donor: (r) =>
            (r.organizationName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
          opportunity: (r) => (r.opportunityName ?? r.opportunityId ?? "").toLowerCase(),
          stage: (r) => r.opportunityStage ?? null,
          winProb: (r) => (r.winProbability != null ? Number(r.winProbability) : null),
          amount: (r) => (r.amount != null ? Number(r.amount) : null),
          weighted: (r) => (r.weightedAmount != null ? Number(r.weightedAmount) : null),
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );
  return (
    <div className="space-y-2" data-testid="report-bucket-open">
      <BucketHeading title="Open pipeline" subtitle="Open opportunity asks, weighted by win probability." />
      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="projectedClose" {...ts}>Projected close</SortableTH>
              <SortableTH colKey="donor" {...ts}>Donor</SortableTH>
              <SortableTH colKey="opportunity" {...ts}>Opportunity</SortableTH>
              <SortableTH colKey="stage" {...ts}>Stage</SortableTH>
              <SortableTH colKey="winProb" align="right" {...ts}>Win prob</SortableTH>
              <SortableTH colKey="amount" align="right" {...ts}>Ask</SortableTH>
              <SortableTH colKey="weighted" align="right" {...ts}>Weighted</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={7} />
            ) : sortedRows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">No open opportunities in this fiscal year + track.</TableCell></TableRow>
            ) : (
              <>
                {sortedRows.map((r) => (
                  <TableRow key={r.rowId} data-testid={`row-${r.rowId}`}>
                    <TableCell className="whitespace-nowrap">{fmtDate(r.projectedCloseDate)}</TableCell>
                    <TableCell>
                      <DonorCell
                        organizationId={r.organizationId}
                        organizationName={r.organizationName}
                        organizationPriority={r.organizationPriority}
                        householdId={r.householdId}
                        householdName={r.householdName}
                        individualGiverPersonId={r.individualGiverPersonId}
                        individualGiverPersonName={r.individualGiverPersonName}
                        individualGiverPersonPriority={r.individualGiverPersonPriority}
                      />
                    </TableCell>
                    <TableCell>
                      <Link href={`/opportunities/${r.opportunityId}`} className="hover:underline">
                        {r.opportunityName ?? r.opportunityId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatEnum(r.opportunityStage)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(r.winProbability)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{fmt(r.amount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(r.weightedAmount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30 font-medium">
                  <TableCell colSpan={5}>Total open</TableCell>
                  <TableCell className="text-right tabular-nums" data-testid="row-open-total-ask">{fmt(totalAsk)}</TableCell>
                  <TableCell className="text-right tabular-nums" data-testid="row-open-total-weighted">{fmt(totalWeighted)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
