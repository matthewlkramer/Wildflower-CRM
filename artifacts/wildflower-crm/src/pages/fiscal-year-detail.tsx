import { useMemo } from "react";
import { Link, useParams, useSearch, useLocation } from "wouter";
import {
  useGetFiscalYearBreakdown,
  useGetDashboardSummary,
  getGetFiscalYearBreakdownQueryKey,
  getGetDashboardSummaryQueryKey,
  type FiscalYearReceivedRow,
  type FiscalYearOpenRow,
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
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

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  // ISO date string from PG — keep YYYY-MM-DD as-is for stable display.
  return s.slice(0, 10);
}

export default function FiscalYearDetail() {
  const params = useParams<{ fyId: string }>();
  const fyId = params.fyId;
  const [, navigate] = useLocation();
  const search = useSearch();
  const metric = parseMetric(new URLSearchParams(search).get("metric"));

  const breakdownQ = useGetFiscalYearBreakdown(fyId, {
    query: { queryKey: getGetFiscalYearBreakdownQueryKey(fyId), enabled: Boolean(fyId) },
  });
  // Powers the FY selector — we use the same two FYs the dashboard shows
  // (current + next), so users navigate between the same set they came from.
  const summaryQ = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() },
  });

  const data = breakdownQ.data;
  const fyOptions = useMemo(
    () => (summaryQ.data?.byFiscalYear ?? []).map((m) => m.fiscalYear),
    [summaryQ.data],
  );

  const setMetric = (m: Metric) => {
    const sp = new URLSearchParams(search);
    sp.set("metric", m);
    navigate(`/fiscal-year/${fyId}?${sp.toString()}`, { replace: true });
  };
  const setFy = (newFyId: string) => {
    if (newFyId === fyId) return;
    const sp = new URLSearchParams(search);
    sp.set("metric", metric);
    navigate(`/fiscal-year/${newFyId}?${sp.toString()}`);
  };

  const fyLabel = data?.fiscalYear.label ?? fyId;

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
          Supporting detail behind the dashboard money tiles. Switch the fiscal year or
          metric to see the rows backing each total.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Fiscal year
        </label>
        <Select value={fyId} onValueChange={setFy}>
          <SelectTrigger className="w-40" data-testid="select-fy">
            <SelectValue placeholder={fyId} />
          </SelectTrigger>
          <SelectContent>
            {fyOptions.map((f) => (
              <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
            ))}
            {/* If the loaded FY isn't in the dashboard pair, still show it. */}
            {!fyOptions.find((f) => f.id === fyId) && fyId ? (
              <SelectItem value={fyId}>{fyLabel}</SelectItem>
            ) : null}
          </SelectContent>
        </Select>

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
            <TableHead>Gift</TableHead>
            <TableHead>Intended usage</TableHead>
            <TableHead className="text-right">Allocation</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
          ) : rows.length === 0 ? (
            <TableRow><TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No gift allocations booked to this fiscal year.</TableCell></TableRow>
          ) : (
            <>
              {rows.map((r) => (
                <TableRow key={r.allocationId} data-testid={`row-received-${r.allocationId}`}>
                  <TableCell className="whitespace-nowrap">{fmtDate(r.dateReceived)}</TableCell>
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
                    <Link href={`/gifts/${r.giftId}`} className="hover:underline">
                      {r.giftType ?? "Gift"}
                      {r.giftAmount ? <span className="text-muted-foreground"> · {formatCurrency(r.giftAmount)}</span> : null}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.intendedUsage ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{fmt(r.subAmount)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-muted/30 font-medium">
                <TableCell colSpan={4}>Total</TableCell>
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
                  <TableCell className="text-muted-foreground">{r.opportunityStage ?? "—"}</TableCell>
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
