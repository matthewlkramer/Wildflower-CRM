import { useMemo } from "react";
import { useListOpportunitiesAndPledges } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const FETCH_LIMIT = 200;

type Bucket = {
  key: string;
  label: string;
  count: number;
  ask: number;
  awarded: number;
  expected: number;
};

function quarterKey(dateStr: string): { key: string; label: string } {
  const [y, m] = dateStr.split("-");
  const month = parseInt(m, 10);
  const q = Math.floor((month - 1) / 3) + 1;
  return { key: `${y}-Q${q}`, label: `Q${q} ${y}` };
}

function toNum(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseProbability(s: string | null | undefined): number {
  if (!s) return 1;
  const trimmed = s.trim();
  const hasPercent = trimmed.includes("%");
  const n = Number(trimmed.replace("%", "").trim());
  if (!Number.isFinite(n)) return 1;
  // If the source explicitly used "%", always divide by 100.
  // Otherwise treat values >1 as percent-shorthand (e.g. "80" -> 0.8).
  const ratio = hasPercent ? n / 100 : n > 1 ? n / 100 : n;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

export default function Projections() {
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges({
    status: "open",
    limit: FETCH_LIMIT,
    page: 1,
  });

  const { buckets, totals } = useMemo(() => {
    const rows = data?.data ?? [];
    const map = new Map<string, Bucket>();
    let tAsk = 0,
      tAwarded = 0,
      tExpected = 0,
      tCount = 0;
    for (const o of rows) {
      if (!o.projectedCloseDate) continue;
      const { key, label } = quarterKey(o.projectedCloseDate);
      const ask = toNum(o.askAmount);
      const awarded = toNum(o.awardedAmount);
      const base = awarded > 0 ? awarded : ask;
      const expected = base * parseProbability(o.winProbability);
      const b = map.get(key) ?? { key, label, count: 0, ask: 0, awarded: 0, expected: 0 };
      b.count += 1;
      b.ask += ask;
      b.awarded += awarded;
      b.expected += expected;
      map.set(key, b);
      tCount += 1;
      tAsk += ask;
      tAwarded += awarded;
      tExpected += expected;
    }
    const buckets = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
    return {
      buckets,
      totals: { count: tCount, ask: tAsk, awarded: tAwarded, expected: tExpected },
    };
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Projections</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open opportunities grouped by projected close quarter. Expected = awarded (or ask if not yet awarded) × win probability.
          {data && data.pagination.total > FETCH_LIMIT ? (
            <span> Showing the first {FETCH_LIMIT} of {data.pagination.total.toLocaleString()}.</span>
          ) : null}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryTile label="Open opps" value={totals.count.toLocaleString()} />
        <SummaryTile label="Total ask" value={formatCurrency(totals.ask)} />
        <SummaryTile label="Total awarded" value={formatCurrency(totals.awarded)} />
        <SummaryTile label="Expected" value={formatCurrency(totals.expected)} />
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quarter</TableHead>
              <TableHead className="text-right">Opportunities</TableHead>
              <TableHead className="text-right">Ask</TableHead>
              <TableHead className="text-right">Awarded</TableHead>
              <TableHead className="text-right">Expected</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : buckets.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No open opportunities with projected close dates.</TableCell></TableRow>
            ) : (
              buckets.map((b) => (
                <TableRow key={b.key} data-testid={`row-projection-${b.key}`}>
                  <TableCell className="font-medium">{b.label}</TableCell>
                  <TableCell className="text-right">{b.count.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{formatCurrency(b.ask)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(b.awarded)}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(b.expected)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
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
