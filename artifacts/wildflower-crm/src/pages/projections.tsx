import { useMemo } from "react";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useGetProjectionsByFyEntity,
  useListEntities,
  useListFiscalYears,
  getGetProjectionsByFyEntityQueryKey,
  getListEntitiesQueryKey,
  getListFiscalYearsQueryKey,
} from "@workspace/api-client-react";
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

const UNBUCKETED = "__unbucketed__";

function toNum(s: string | null | undefined): number {
  if (s === null || s === undefined) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export default function Projections() {
  const proj = useGetProjectionsByFyEntity({
    query: { queryKey: getGetProjectionsByFyEntityQueryKey() },
  });
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey() },
  });
  const fyQ = useListFiscalYears({
    query: { queryKey: getListFiscalYearsQueryKey() },
  });

  const { fyRows, entityCols, cell, fyTotals, entityTotals, grandAlloc, grandAsk, grandExpected } =
    useMemo(() => {
      const rows = proj.data?.rows ?? [];

      // Which fiscal years and which entities actually appear in the data?
      const fySeen = new Set<string>();
      const entSeen = new Set<string>();
      for (const r of rows) {
        fySeen.add(r.grantYear ?? UNBUCKETED);
        entSeen.add(r.entityId ?? UNBUCKETED);
      }

      // Order fiscal years by their slug ("fyNNNN", plus "future"/"__unbucketed__"
      // pinned to the end).
      const fyRows = Array.from(fySeen).sort((a, b) => {
        const aFuture = a === "future" || a === UNBUCKETED;
        const bFuture = b === "future" || b === UNBUCKETED;
        if (aFuture && !bFuture) return 1;
        if (!aFuture && bFuture) return -1;
        if (aFuture && bFuture) return a.localeCompare(b);
        return a.localeCompare(b);
      });

      // Order entity columns by the catalog's natural name order, falling back
      // to slug if the catalog hasn't loaded yet. Unknown / null pinned last.
      const entityById = new Map(
        (entitiesQ.data ?? []).map((e) => [e.id, e.name] as const),
      );
      const entityCols = Array.from(entSeen).sort((a, b) => {
        if (a === UNBUCKETED && b !== UNBUCKETED) return 1;
        if (b === UNBUCKETED && a !== UNBUCKETED) return -1;
        const na = entityById.get(a) ?? a;
        const nb = entityById.get(b) ?? b;
        return na.localeCompare(nb);
      });

      const cell = new Map<string, { ask: number; expected: number; n: number }>();
      const fyTotals = new Map<string, { ask: number; expected: number; n: number }>();
      const entityTotals = new Map<string, { ask: number; expected: number; n: number }>();
      let grandAsk = 0,
        grandExpected = 0,
        grandAlloc = 0;
      for (const r of rows) {
        const fy = r.grantYear ?? UNBUCKETED;
        const ent = r.entityId ?? UNBUCKETED;
        const ask = toNum(r.totalSubAmount);
        const expected = toNum(r.expected);
        const n = r.allocationCount;
        const key = `${fy}|${ent}`;
        const c = cell.get(key) ?? { ask: 0, expected: 0, n: 0 };
        c.ask += ask;
        c.expected += expected;
        c.n += n;
        cell.set(key, c);
        const ft = fyTotals.get(fy) ?? { ask: 0, expected: 0, n: 0 };
        ft.ask += ask;
        ft.expected += expected;
        ft.n += n;
        fyTotals.set(fy, ft);
        const et = entityTotals.get(ent) ?? { ask: 0, expected: 0, n: 0 };
        et.ask += ask;
        et.expected += expected;
        et.n += n;
        entityTotals.set(ent, et);
        grandAsk += ask;
        grandExpected += expected;
        grandAlloc += n;
      }
      return { fyRows, entityCols, cell, fyTotals, entityTotals, grandAlloc, grandAsk, grandExpected };
    }, [proj.data, entitiesQ.data]);

  const entityName = (id: string) => {
    if (id === UNBUCKETED) return "Unassigned";
    return (entitiesQ.data ?? []).find((e) => e.id === id)?.name ?? id;
  };
  const fyLabel = (id: string) => {
    if (id === UNBUCKETED) return "Unassigned";
    return (fyQ.data ?? []).find((f) => f.id === id)?.label ?? id;
  };

  const isLoading = proj.isLoading;
  const isError = proj.isError;
  const error = proj.error;

  const ts = useTableState("projections", { key: "fy", dir: "asc" });
  const sortedFyRows = useMemo(() => {
    // Build a sortable record per FY. The fy accessor returns the row's
    // original index so the default sort preserves upstream ordering
    // (special buckets like __unbucketed__ already pinned to the end).
    const records = fyRows.map((fy, idx) => {
      const rec: Record<string, unknown> = {
        __fy: fy,
        __order: idx,
        rowTotal: fyTotals.get(fy)?.expected ?? null,
      };
      for (const ent of entityCols) {
        rec[`ent_${ent}`] = cell.get(`${fy}|${ent}`)?.expected ?? null;
      }
      return rec;
    });
    const accessors: Record<string, (r: Record<string, unknown>) => unknown> = {
      fy: (r) => r.__order as number,
      rowTotal: (r) => r.rowTotal as number | null,
    };
    for (const ent of entityCols) {
      accessors[`ent_${ent}`] = (r) => r[`ent_${ent}`] as number | null;
    }
    return sortRows(records, accessors, ts.sort).map((r) => r.__fy as string);
  }, [fyRows, entityCols, cell, fyTotals, ts.sort]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Projections</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open-pipeline scope from <code className="text-xs">pledge_allocations</code>,
          grouped by fiscal year × fund entity. <span className="font-medium">Expected</span>{" "}
          weights each allocation's sub-amount by the parent opportunity's win probability
          (defaulting to 1 when unset).
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryTile label="Allocation rows" value={grandAlloc.toLocaleString()} />
        <SummaryTile label="Total ask" value={formatCurrency(grandAsk)} />
        <SummaryTile label="Total expected" value={formatCurrency(grandExpected)} />
        <SummaryTile label="Fiscal years" value={fyRows.length.toLocaleString()} />
      </div>

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="fy" {...ts}>Fiscal year</SortableTH>
              {entityCols.map((e) => (
                <SortableTH key={e} colKey={`ent_${e}`} align="right" {...ts} className="whitespace-nowrap">
                  {entityName(e)}
                </SortableTH>
              ))}
              <SortableTH colKey="rowTotal" align="right" {...ts} className="whitespace-nowrap">Row total</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={Math.max(entityCols.length + 2, 2)}
                  className="text-center h-24 text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={Math.max(entityCols.length + 2, 2)}
                  className="text-center h-24 text-destructive"
                >
                  {error instanceof Error ? error.message : "Failed to load projections."}
                </TableCell>
              </TableRow>
            ) : fyRows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={Math.max(entityCols.length + 2, 2)}
                  className="text-center h-24 text-muted-foreground"
                >
                  No open allocations.
                </TableCell>
              </TableRow>
            ) : (
              <>
                {sortedFyRows.map((fy) => {
                  const rowTotal = fyTotals.get(fy);
                  return (
                    <TableRow key={fy} data-testid={`row-projection-${fy}`}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {fyLabel(fy)}
                      </TableCell>
                      {entityCols.map((ent) => {
                        const c = cell.get(`${fy}|${ent}`);
                        return (
                          <TableCell
                            key={ent}
                            className="text-right tabular-nums"
                            data-testid={`cell-${fy}-${ent}`}
                          >
                            {c ? formatCurrency(c.expected) : "—"}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right font-medium tabular-nums">
                        {rowTotal ? formatCurrency(rowTotal.expected) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted/30 font-medium">
                  <TableCell>Column total</TableCell>
                  {entityCols.map((ent) => {
                    const t = entityTotals.get(ent);
                    return (
                      <TableCell key={ent} className="text-right tabular-nums">
                        {t ? formatCurrency(t.expected) : "—"}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(grandExpected)}
                  </TableCell>
                </TableRow>
              </>
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
