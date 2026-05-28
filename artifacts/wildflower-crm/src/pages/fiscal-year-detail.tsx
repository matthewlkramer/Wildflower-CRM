import { useMemo, useState } from "react";
import { Link, useParams, useSearch, useLocation } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useGetFiscalYearBreakdown,
  useListFiscalYears,
  useListEntities,
  getGetFiscalYearBreakdownQueryKey,
  getListFiscalYearsQueryKey,
  getListEntitiesQueryKey,
  type FiscalYearReceivedRow,
  type FiscalYearOpenRow,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort, formatEnum, abbreviateUsStates } from "@/lib/format";
import { partitionFiscalYears } from "@/lib/dropdownVisibility";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DonorCell } from "@/components/donor-cell";
import { useEntityFilter } from "@/lib/entity-filter-context";

type Metric = "received" | "open-asks" | "weighted-asks";

const METRIC_LABELS: Record<Metric, string> = {
  received: "Received",
  "open-asks": "Open asks",
  "weighted-asks": "Weighted asks",
};

// Fallback when no entity is in the global filter. Matches the previous
// page default; in normal flow users arrive here from the dashboard with
// the header entity filter already narrowed to a single entity.
const DEFAULT_ENTITY_ID = "wildflower_foundation";

function parseMetric(s: string | null): Metric {
  if (s === "received" || s === "open-asks" || s === "weighted-asks") return s;
  return "received";
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

// Use the shared short formatter so this matches every other list-view
// table on the site. Note dashboard tiles still call `formatDate` for
// long-form prose.
function fmtDate(s: string | null | undefined): string {
  return formatDateShort(s);
}

export default function FiscalYearDetail() {
  const params = useParams<{ fyId: string }>();
  const fyId = params.fyId;
  const [, navigate] = useLocation();
  const search = useSearch();
  const sp = new URLSearchParams(search);
  const metric = parseMetric(sp.get("metric"));

  // Entity is sourced from the global header filter. The page-local entity
  // dropdown was removed because it duplicated the header. When the header
  // filter is empty (all entities) or has >1 entity selected, we fall back
  // to Wildflower Foundation — the dashboard already prevents drilldown
  // when multiple entities are selected, so the multi-entity case is
  // defensive only.
  const { selected: selectedEntityIds } = useEntityFilter();
  const entityId =
    selectedEntityIds.length === 1 ? selectedEntityIds[0] : DEFAULT_ENTITY_ID;

  const breakdownParams = { entityId };
  const breakdownQ = useGetFiscalYearBreakdown(fyId, breakdownParams, {
    query: {
      queryKey: getGetFiscalYearBreakdownQueryKey(fyId, breakdownParams),
      enabled: Boolean(fyId),
    },
  });
  // All fiscal years so the dropdown isn't limited to just current+next.
  const fyListQ = useListFiscalYears({
    query: { queryKey: getListFiscalYearsQueryKey(), staleTime: 5 * 60_000 },
  });
  // Entities list is still loaded so we can resolve the selected entity's
  // display name for the page subtitle.
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });

  const data = breakdownQ.data;
  const fyOptions = useMemo(() => {
    const rows = (fyListQ.data ?? []).map((f) => ({ id: f.id, label: f.label }));
    // Sort newest first (FY slug is `fy<endYear>`, so reverse-sort alphabetically works).
    rows.sort((a, b) => b.id.localeCompare(a.id));
    return rows;
  }, [fyListQ.data]);

  // Default-visible window: recent FYs (last 3 + current + next). Older FYs
  // sit behind an expand toggle. Auto-expand if the current selection is in
  // the hidden set so the user can still see / change their selection.
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

  const setMetric = (m: Metric) => {
    const next = new URLSearchParams(search);
    next.set("metric", m);
    navigate(`/fiscal-year/${fyId}?${next.toString()}`, { replace: true });
  };
  const setFy = (newFyId: string) => {
    if (newFyId === fyId) return;
    const next = new URLSearchParams(search);
    next.set("metric", metric);
    navigate(`/fiscal-year/${newFyId}?${next.toString()}`);
  };

  const fyLabel = data?.fiscalYear.label ?? fyId;
  const selectedEntityName =
    (entitiesQ.data ?? []).find((e) => e.id === entityId)?.name ?? entityId;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-muted-foreground">
          <Link href="/dashboard" className="hover:underline">Dashboard</Link>
          <span className="mx-1">/</span>
          <span>Fiscal year detail</span>
        </div>
        <h1 className="text-3xl font-serif font-bold text-foreground mt-1">
          {fyLabel} · {METRIC_LABELS[metric]}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Supporting detail behind the dashboard money tiles. Filtered to{" "}
          <span className="font-medium">{selectedEntityName}</span> (change the
          entity from the header filter). Click a tile below to switch metric.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
              {/* If the loaded FY isn't in the list yet (loading), still show it. */}
              {!fyOptions.find((f) => f.id === fyId) && fyId ? (
                <SelectItem value={fyId}>{fyLabel}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          {/* Toggle lives outside <SelectContent> so the click never races
              Radix's pointer/portal handling. Hidden when selection forces
              the bucket open (can't usefully collapse). */}
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryTile label={`Goal ${fyLabel}`} value={fmt(data?.goal ?? null)} testId="tile-detail-goal" />
        <SummaryTile
          label={`Received ${fyLabel}`}
          value={fmt(data?.received.total)}
          testId="tile-detail-received"
          highlight={metric === "received"}
          onClick={() => setMetric("received")}
        />
        <SummaryTile
          label={`Open asks ${fyLabel}`}
          value={fmt(data?.openPipeline.totalAsk)}
          testId="tile-detail-open"
          highlight={metric === "open-asks"}
          onClick={() => setMetric("open-asks")}
        />
        <SummaryTile
          label={`Weighted asks ${fyLabel}`}
          value={fmt(data?.openPipeline.totalWeighted)}
          testId="tile-detail-weighted"
          highlight={metric === "weighted-asks"}
          onClick={() => setMetric("weighted-asks")}
        />
      </div>

      {breakdownQ.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive" data-testid="detail-error">
          {breakdownQ.error instanceof Error ? breakdownQ.error.message : "Failed to load fiscal year detail."}
        </div>
      ) : null}

      {metric === "received" ? (
        <ReceivedTable
          rows={data?.received.rows ?? []}
          total={data?.received.total ?? "0"}
          isLoading={breakdownQ.isLoading}
        />
      ) : (
        <OpenTable
          rows={data?.openPipeline.rows ?? []}
          totalAsk={data?.openPipeline.totalAsk ?? "0"}
          totalWeighted={data?.openPipeline.totalWeighted ?? "0"}
          highlight={metric === "weighted-asks" ? "weighted" : "ask"}
          isLoading={breakdownQ.isLoading}
        />
      )}
    </div>
  );
}

function SummaryTile({
  label, value, testId, highlight, onClick,
}: {
  label: string;
  value: string;
  testId: string;
  highlight?: boolean;
  onClick?: () => void;
}) {
  // Tiles double as the metric picker: click swaps which detail table
  // (Received vs Open asks vs Weighted asks) is shown below. Goal has no
  // drilldown table so it's rendered as a plain (non-clickable) card.
  const clickable = Boolean(onClick);
  const card = (
    <Card
      data-testid={testId}
      className={[
        highlight ? "ring-2 ring-primary" : undefined,
        clickable ? "transition hover:bg-muted/40 hover:shadow-sm" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
    >
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
  if (!clickable) return card;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={highlight}
      className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
    >
      {card}
    </button>
  );
}

function ReceivedTable({
  rows, total, isLoading,
}: { rows: FiscalYearReceivedRow[]; total: string; isLoading: boolean }) {
  const ts = useTableState("fy-received", { key: "dateReceived", dir: "desc" });
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          dateReceived: (r) => r.dateReceived ?? null,
          donor: (r) =>
            (r.funderName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
          usage: (r) => r.displayUsage?.toLowerCase() ?? null,
          amount: (r) => (r.subAmount != null ? Number(r.subAmount) : null),
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );
  return (
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
            <TableRow><TableCell colSpan={4} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
          ) : sortedRows.length === 0 ? (
            <TableRow><TableCell colSpan={4} className="text-center h-24 text-muted-foreground">No gift allocations booked to this fiscal year.</TableCell></TableRow>
          ) : (
            <>
              {sortedRows.map((r) => (
                <TableRow key={r.allocationId} data-testid={`row-received-${r.allocationId}`}>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/gifts/${r.giftId}`} className="hover:underline">
                      {fmtDate(r.dateReceived)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DonorCell
                      funderId={r.funderId}
                      funderName={r.funderName}
                      funderIsPriority={r.funderIsPriority}
                      householdId={r.householdId}
                      householdName={r.householdName}
                      individualGiverPersonId={r.individualGiverPersonId}
                      individualGiverPersonName={r.individualGiverPersonName}
                      individualGiverPersonIsPriority={r.individualGiverPersonIsPriority}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.displayUsage ? abbreviateUsStates(r.displayUsage) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{fmt(r.subAmount)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/30 font-medium">
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right tabular-nums" data-testid="row-received-total">{fmt(total)}</TableCell>
              </TableRow>
            </>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function OpenTable({
  rows, totalAsk, totalWeighted, highlight, isLoading,
}: {
  rows: FiscalYearOpenRow[];
  totalAsk: string;
  totalWeighted: string;
  highlight: "ask" | "weighted";
  isLoading: boolean;
}) {
  // Persist sort/widths per highlight mode so switching Ask ↔ Weighted
  // doesn't strand the user on a sort key tied to the other metric.
  const ts = useTableState(`fy-open-${highlight}`, {
    key: highlight === "weighted" ? "weighted" : "ask",
    dir: "desc",
  });
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          projectedClose: (r) => r.projectedCloseDate ?? null,
          donor: (r) =>
            (r.funderName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
          opportunity: (r) => (r.opportunityName ?? r.opportunityId ?? "").toLowerCase(),
          stage: (r) => r.opportunityStage ?? null,
          winProb: (r) => (r.winProbability != null ? Number(r.winProbability) : null),
          ask: (r) => (r.subAmount != null ? Number(r.subAmount) : null),
          weighted: (r) => (r.weightedAmount != null ? Number(r.weightedAmount) : null),
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );
  return (
    <div className="rounded-md border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableTH colKey="projectedClose" {...ts}>Projected close</SortableTH>
            <SortableTH colKey="donor" {...ts}>Donor</SortableTH>
            <SortableTH colKey="opportunity" {...ts}>Opportunity</SortableTH>
            <SortableTH colKey="stage" {...ts}>Stage</SortableTH>
            <SortableTH colKey="winProb" align="right" {...ts}>Win prob</SortableTH>
            <SortableTH colKey="ask" align="right" {...ts} className={highlight === "ask" ? "font-semibold" : undefined}>Ask</SortableTH>
            <SortableTH colKey="weighted" align="right" {...ts} className={highlight === "weighted" ? "font-semibold" : undefined}>Weighted</SortableTH>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
          ) : sortedRows.length === 0 ? (
            <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">No open pledge allocations booked to this fiscal year.</TableCell></TableRow>
          ) : (
            <>
              {sortedRows.map((r) => (
                <TableRow key={r.allocationId} data-testid={`row-open-${r.allocationId}`}>
                  <TableCell className="whitespace-nowrap">{fmtDate(r.projectedCloseDate)}</TableCell>
                  <TableCell>
                    <DonorCell
                      funderId={r.funderId}
                      funderName={r.funderName}
                      funderIsPriority={r.funderIsPriority}
                      householdId={r.householdId}
                      householdName={r.householdName}
                      individualGiverPersonId={r.individualGiverPersonId}
                      individualGiverPersonName={r.individualGiverPersonName}
                      individualGiverPersonIsPriority={r.individualGiverPersonIsPriority}
                    />
                  </TableCell>
                  <TableCell>
                    <Link href={`/opportunities/${r.opportunityId}`} className="hover:underline">
                      {r.opportunityName ?? r.opportunityId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatEnum(r.opportunityStage)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.winProbability)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${highlight === "ask" ? "font-medium" : ""}`}>{fmt(r.subAmount)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${highlight === "weighted" ? "font-medium" : ""}`}>{fmt(r.weightedAmount)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/30 font-medium">
                <TableCell colSpan={5}>Total</TableCell>
                <TableCell className="text-right tabular-nums" data-testid="row-open-total-ask">{fmt(totalAsk)}</TableCell>
                <TableCell className="text-right tabular-nums" data-testid="row-open-total-weighted">{fmt(totalWeighted)}</TableCell>
              </TableRow>
            </>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
