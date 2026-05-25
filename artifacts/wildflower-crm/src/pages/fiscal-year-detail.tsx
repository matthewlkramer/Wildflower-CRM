import { useMemo, useState } from "react";
import { Link, useParams, useSearch, useLocation } from "wouter";
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
import { partitionEntities, partitionFiscalYears } from "@/lib/dropdownVisibility";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DonorCell } from "@/components/donor-cell";

type Metric = "received" | "open-asks" | "weighted-asks";

const METRIC_LABELS: Record<Metric, string> = {
  received: "Received",
  "open-asks": "Open asks",
  "weighted-asks": "Weighted asks",
};

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
  // Entity defaults to Wildflower Foundation; user can override via URL or dropdown.
  const entityId = (sp.get("entity") ?? DEFAULT_ENTITY_ID).trim() || DEFAULT_ENTITY_ID;

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
  const entityOptions = useMemo(
    () => (entitiesQ.data ?? []).map((e) => ({ id: e.id, name: e.name, active: e.active })),
    [entitiesQ.data],
  );

  // Default-visible window: recent FYs (last 3 + current + next) and
  // non-retired entities. Older FYs / retired entities sit behind an
  // expand toggle. Auto-expand if the current selection is in the hidden
  // set so the user can still see / change their selection in the list.
  const { recent: recentFyOptions, older: olderFyOptions } = useMemo(
    () => partitionFiscalYears(fyOptions),
    [fyOptions],
  );
  const { active: activeEntityOptions, retired: retiredEntityOptions } = useMemo(
    () => partitionEntities(entityOptions),
    [entityOptions],
  );
  const fyHidden = olderFyOptions.some((f) => f.id === fyId);
  const entityHidden = retiredEntityOptions.some((e) => e.id === entityId);
  const [showAllFy, setShowAllFy] = useState(false);
  const [showRetiredEntities, setShowRetiredEntities] = useState(false);
  // Force-expand whenever the current selection lives in the hidden bucket
  // so the user can still see (and change away from) their selection in the
  // list. Derived rather than effect-backed so it survives the initial
  // render where async option lists haven't loaded yet — no timing race.
  const effectiveShowAllFy = showAllFy || fyHidden;
  const effectiveShowRetiredEntities = showRetiredEntities || entityHidden;
  const visibleFyOptions = effectiveShowAllFy
    ? [...recentFyOptions, ...olderFyOptions]
    : recentFyOptions;
  const visibleEntityOptions = effectiveShowRetiredEntities
    ? [...activeEntityOptions, ...retiredEntityOptions]
    : activeEntityOptions;

  const updateQuery = (mut: (sp: URLSearchParams) => void, opts?: { replace?: boolean }) => {
    const next = new URLSearchParams(search);
    mut(next);
    navigate(`/fiscal-year/${fyId}?${next.toString()}`, { replace: opts?.replace });
  };
  const setMetric = (m: Metric) => updateQuery((p) => p.set("metric", m), { replace: true });
  const setEntity = (e: string) => updateQuery((p) => p.set("entity", e));
  const setFy = (newFyId: string) => {
    if (newFyId === fyId) return;
    const next = new URLSearchParams(search);
    next.set("metric", metric);
    next.set("entity", entityId);
    navigate(`/fiscal-year/${newFyId}?${next.toString()}`);
  };

  const fyLabel = data?.fiscalYear.label ?? fyId;
  const selectedEntityName =
    entityOptions.find((e) => e.id === entityId)?.name ?? entityId;

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
          <span className="font-medium">{selectedEntityName}</span>. Switch the
          fiscal year, entity, or metric to see different rows.
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

        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide ml-2">
          Entity
        </label>
        <div className="flex flex-col items-start gap-0.5">
          <Select value={entityId} onValueChange={setEntity}>
            <SelectTrigger className="w-64" data-testid="select-entity">
              <SelectValue placeholder={selectedEntityName} />
            </SelectTrigger>
            <SelectContent>
              {visibleEntityOptions.map((e) => (
                <SelectItem key={e.id} value={e.id} data-testid={`select-entity-option-${e.id}`}>
                  {e.name}
                </SelectItem>
              ))}
              {!entityOptions.find((e) => e.id === entityId) ? (
                <SelectItem value={entityId}>{selectedEntityName}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          {retiredEntityOptions.length > 0 && !entityHidden ? (
            <button
              type="button"
              data-testid="select-entity-toggle"
              onClick={() => setShowRetiredEntities((s) => !s)}
              className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline px-1"
            >
              {effectiveShowRetiredEntities
                ? "Hide retired entities"
                : `Show retired entities (+${retiredEntityOptions.length})`}
            </button>
          ) : null}
        </div>

        <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
          <TabsList>
            <TabsTrigger value="received" data-testid="tab-received">Received</TabsTrigger>
            <TabsTrigger value="open-asks" data-testid="tab-open-asks">Open asks</TabsTrigger>
            <TabsTrigger value="weighted-asks" data-testid="tab-weighted-asks">Weighted asks</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryTile label={`Goal ${fyLabel}`} value={fmt(data?.goal ?? null)} testId="tile-detail-goal" />
        <SummaryTile label={`Received ${fyLabel}`} value={fmt(data?.received.total)} testId="tile-detail-received" highlight={metric === "received"} />
        <SummaryTile label={`Open asks ${fyLabel}`} value={fmt(data?.openPipeline.totalAsk)} testId="tile-detail-open" highlight={metric === "open-asks"} />
        <SummaryTile label={`Weighted asks ${fyLabel}`} value={fmt(data?.openPipeline.totalWeighted)} testId="tile-detail-weighted" highlight={metric === "weighted-asks"} />
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
  label, value, testId, highlight,
}: { label: string; value: string; testId: string; highlight?: boolean }) {
  return (
    <Card data-testid={testId} className={highlight ? "ring-2 ring-primary" : undefined}>
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

function ReceivedTable({
  rows, total, isLoading,
}: { rows: FiscalYearReceivedRow[]; total: string; isLoading: boolean }) {
  return (
    <div className="rounded-md border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date received</TableHead>
            <TableHead>Donor</TableHead>
            <TableHead>Usage</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={4} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
          ) : rows.length === 0 ? (
            <TableRow><TableCell colSpan={4} className="text-center h-24 text-muted-foreground">No gift allocations booked to this fiscal year.</TableCell></TableRow>
          ) : (
            <>
              {rows.map((r) => (
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
                      householdId={r.householdId}
                      householdName={r.householdName}
                      individualGiverPersonId={r.individualGiverPersonId}
                      individualGiverPersonName={r.individualGiverPersonName}
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
  return (
    <div className="rounded-md border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Projected close</TableHead>
            <TableHead>Donor</TableHead>
            <TableHead>Opportunity</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead className="text-right">Win prob</TableHead>
            <TableHead className={highlight === "ask" ? "text-right font-semibold" : "text-right"}>Ask</TableHead>
            <TableHead className={highlight === "weighted" ? "text-right font-semibold" : "text-right"}>Weighted</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
          ) : rows.length === 0 ? (
            <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">No open pledge allocations booked to this fiscal year.</TableCell></TableRow>
          ) : (
            <>
              {rows.map((r) => (
                <TableRow key={r.allocationId} data-testid={`row-open-${r.allocationId}`}>
                  <TableCell className="whitespace-nowrap">{fmtDate(r.projectedCloseDate)}</TableCell>
                  <TableCell>
                    <DonorCell
                      funderId={r.funderId}
                      funderName={r.funderName}
                      householdId={r.householdId}
                      householdName={r.householdName}
                      individualGiverPersonId={r.individualGiverPersonId}
                      individualGiverPersonName={r.individualGiverPersonName}
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
