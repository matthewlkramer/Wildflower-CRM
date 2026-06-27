import { useMemo, useState } from "react";
import {
  useGetReconciliationCrosscheck,
  getGetReconciliationCrosscheckQueryKey,
  getReconciliationCrosscheck,
  type ReconciliationCrosscheckSource,
  type ReconciliationClassification,
  type ReconciliationCrosscheckRow,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Download } from "lucide-react";

const PAGE_SIZE = 100;

const SOURCE_LABEL: Record<ReconciliationCrosscheckSource, string> = {
  stripe_donorbox: "Stripe / Donorbox",
  stripe_815: "Stripe (815 details)",
  qbo_fy25: "QuickBooks FY25",
};

const CLASSIFICATION_LABEL: Record<ReconciliationClassification, string> = {
  matched: "Matched",
  amount_mismatch: "Amount mismatch",
  missing: "Missing",
};

const CLASSIFICATION_VARIANT: Record<
  ReconciliationClassification,
  "default" | "secondary" | "destructive" | "outline"
> = {
  matched: "secondary",
  amount_mismatch: "outline",
  missing: "destructive",
};

const ALL = "all";

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS: {
  header: string;
  get: (r: ReconciliationCrosscheckRow) => string | number | null | undefined;
}[] = [
  { header: "Source", get: (r) => SOURCE_LABEL[r.source] },
  { header: "Classification", get: (r) => CLASSIFICATION_LABEL[r.classification] },
  { header: "Date", get: (r) => r.date ?? "" },
  { header: "Donor name", get: (r) => r.donorName ?? "" },
  { header: "Donor email", get: (r) => r.donorEmail ?? "" },
  { header: "Gross amount", get: (r) => r.grossAmount ?? "" },
  { header: "Fee amount", get: (r) => r.feeAmount ?? "" },
  { header: "Net amount", get: (r) => r.netAmount ?? "" },
  { header: "Stripe charge id", get: (r) => r.stripeChargeId ?? "" },
  { header: "QBO type", get: (r) => r.qboType ?? "" },
  { header: "QBO num", get: (r) => r.qboNum ?? "" },
  { header: "QBO account", get: (r) => r.qboAccount ?? "" },
  { header: "QBO location", get: (r) => r.qboLocation ?? "" },
  { header: "QBO memo", get: (r) => r.qboMemo ?? "" },
  { header: "CRM amount", get: (r) => r.crmAmount ?? "" },
  { header: "CRM record kind", get: (r) => r.crmRecordKind ?? "" },
  { header: "CRM record id", get: (r) => r.crmRecordId ?? "" },
  { header: "Match basis", get: (r) => r.matchBasis },
];

const EXPORT_PAGE_SIZE = 1000;

export default function ReconciliationCrosscheck() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const [source, setSource] = useState<ReconciliationCrosscheckSource | typeof ALL>(ALL);
  const [classification, setClassification] = useState<
    ReconciliationClassification | typeof ALL
  >(ALL);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [isExporting, setIsExporting] = useState(false);

  const params = useMemo(
    () => ({
      ...(source !== ALL ? { source } : {}),
      ...(classification !== ALL ? { classification } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      limit: PAGE_SIZE,
      page,
    }),
    [source, classification, search, page],
  );

  const { data, isLoading, isError, error } = useGetReconciliationCrosscheck(params, {
    query: {
      enabled: isAdmin,
      queryKey: getGetReconciliationCrosscheckQueryKey(params),
    },
  });

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold">Reconciliation Cross-Check</h1>
        <p className="mt-2 text-muted-foreground">
          This report is available to admins only.
        </p>
      </div>
    );
  }

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const grandGapAmount = (data?.bySource ?? []).reduce(
    (sum, s) => sum + s.missingAmount,
    0,
  );
  const grandMissingCount = (data?.bySource ?? []).reduce(
    (sum, s) => sum + s.missing,
    0,
  );

  async function exportCsv() {
    if (isExporting) return;
    setIsExporting(true);
    try {
      // Fetch every row matching the active filters (across all pages) rather
      // than just the visible page. We loop paginated requests so the export
      // stays correct even if the dataset grows past the server's page cap.
      const filters = {
        ...(source !== ALL ? { source } : {}),
        ...(classification !== ALL ? { classification } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      };
      const allRows: ReconciliationCrosscheckRow[] = [];
      let exportPage = 1;
      for (;;) {
        const result = await getReconciliationCrosscheck({
          ...filters,
          limit: EXPORT_PAGE_SIZE,
          page: exportPage,
        });
        allRows.push(...result.data);
        const fetchedTotal = result.pagination.total;
        if (allRows.length >= fetchedTotal || result.data.length === 0) break;
        exportPage += 1;
      }

      if (allRows.length === 0) {
        toast({
          title: "Nothing to export",
          description: "No rows match the current filters.",
        });
        return;
      }

      const header = CSV_COLUMNS.map((c) => csvCell(c.header)).join(",");
      const body = allRows
        .map((r) => CSV_COLUMNS.map((c) => csvCell(c.get(r))).join(","))
        .join("\n");
      const csv = `${header}\n${body}`;
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `reconciliation-crosscheck-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: "Export failed",
        description: (err as Error)?.message ?? "Could not export the report.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  }

  function resetPageAnd<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
    };
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Reconciliation Cross-Check</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only audit of three historical transaction spreadsheets against the
          CRM's synced Stripe charges, staged payments, and gifts. Nothing here is
          imported or modified — it only surfaces where the sheets and the CRM
          disagree.
        </p>
      </div>

      {/* Aggregate gap summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card data-testid="card-total-gap">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total unreconciled gap
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {formatCurrency(grandGapAmount)}
            </div>
            <div className="text-xs text-muted-foreground">
              {grandMissingCount.toLocaleString()} missing rows
            </div>
          </CardContent>
        </Card>
        {(data?.bySource ?? []).map((s) => (
          <Card key={s.source} data-testid={`card-source-${s.source}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {SOURCE_LABEL[s.source]}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">
                {formatCurrency(s.missingAmount)}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.matched.toLocaleString()} matched · {s.amountMismatch.toLocaleString()}{" "}
                mismatch · {s.missing.toLocaleString()} missing
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Source</label>
          <Select
            value={source}
            onValueChange={resetPageAnd((v) =>
              setSource(v as ReconciliationCrosscheckSource | typeof ALL),
            )}
          >
            <SelectTrigger className="w-52" data-testid="select-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              <SelectItem value="stripe_donorbox">{SOURCE_LABEL.stripe_donorbox}</SelectItem>
              <SelectItem value="stripe_815">{SOURCE_LABEL.stripe_815}</SelectItem>
              <SelectItem value="qbo_fy25">{SOURCE_LABEL.qbo_fy25}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Classification</label>
          <Select
            value={classification}
            onValueChange={resetPageAnd((v) =>
              setClassification(v as ReconciliationClassification | typeof ALL),
            )}
          >
            <SelectTrigger className="w-48" data-testid="select-classification">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="matched">{CLASSIFICATION_LABEL.matched}</SelectItem>
              <SelectItem value="amount_mismatch">
                {CLASSIFICATION_LABEL.amount_mismatch}
              </SelectItem>
              <SelectItem value="missing">{CLASSIFICATION_LABEL.missing}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-xs text-muted-foreground">Search</label>
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Donor name, email, or Stripe charge id"
            className="max-w-sm"
            data-testid="input-search"
          />
        </div>
        <Button
          variant="outline"
          onClick={exportCsv}
          disabled={total === 0 || isExporting}
          data-testid="button-export-csv"
        >
          <Download className="mr-2 h-4 w-4" />
          {isExporting ? "Exporting…" : "Export CSV (all)"}
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Donor</TableHead>
              <TableHead className="text-right">Sheet amount</TableHead>
              <TableHead className="text-right">CRM amount</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Match basis</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-destructive">
                  Failed to load: {(error as Error)?.message ?? "unknown error"}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  No rows match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.rowRef} data-testid={`row-${r.rowRef}`}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {SOURCE_LABEL[r.source]}
                  </TableCell>
                  <TableCell>
                    <Badge variant={CLASSIFICATION_VARIANT[r.classification]}>
                      {CLASSIFICATION_LABEL[r.classification]}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {formatDateShort(r.date ?? null)}
                  </TableCell>
                  <TableCell className="max-w-[16rem]">
                    <div className="truncate text-sm">{r.donorName ?? "—"}</div>
                    {r.donorEmail ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {r.donorEmail}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {r.grossAmount != null ? formatCurrency(r.grossAmount) : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {r.crmAmount != null ? formatCurrency(r.crmAmount) : "—"}
                  </TableCell>
                  <TableCell className="max-w-[14rem]">
                    <div className="truncate text-xs text-muted-foreground">
                      {r.stripeChargeId ||
                        [r.qboType, r.qboNum].filter(Boolean).join(" ") ||
                        "—"}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[20rem]">
                    <div className="truncate text-xs text-muted-foreground">
                      {r.matchBasis}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {total.toLocaleString()} row{total === 1 ? "" : "s"}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            data-testid="button-prev-page"
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={page >= pageCount}
            data-testid="button-next-page"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
