import { useMemo, useState } from "react";
import {
  useGetRevenueExtractorReport,
  getGetRevenueExtractorReportQueryKey,
  type RevenueExtractorRow,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ListPageHeader } from "@/components/list-page-header";
import { useToast } from "@/hooks/use-toast";
import { Download, AlertTriangle } from "lucide-react";

/* ──────────────────────────────────────────────────────────────────────────
   The finance team's "Revenue Extractor" — one coded row per gift allocation
   across the 19 columns of their live spreadsheet, plus a separate negative
   processor-fee expense line for gifts with fees. QuickBooks stays authoritative;
   we surface where the CRM-derived coding disagrees with the linked QB snapshot.
   ────────────────────────────────────────────────────────────────────────── */

// The 19 report columns, in the finance spreadsheet's order.
const COLUMNS: {
  header: string;
  get: (r: RevenueExtractorRow) => string | null | undefined;
  className?: string;
}[] = [
  { header: "Object Code", get: (r) => r.objectCode },
  { header: "Transaction Date", get: (r) => r.transactionDate },
  { header: "Name", get: (r) => r.name },
  { header: "Location", get: (r) => r.location },
  { header: "Memo/Description", get: (r) => r.memoDescription },
  { header: "Amount", get: (r) => r.amount, className: "text-right tabular-nums" },
  { header: "Revenue Type", get: (r) => r.revenueType },
  { header: "Grant Title / Reference #", get: (r) => r.titleReference },
  { header: "Grant Period Start", get: (r) => r.periodStart },
  { header: "Grant Period End", get: (r) => r.periodEnd },
  { header: "Payment Schedule", get: (r) => r.paymentSchedule },
  { header: "Restriction Type", get: (r) => r.restrictionType },
  { header: "Purpose", get: (r) => r.purpose },
  { header: "Suggested Class", get: (r) => r.suggestedClass },
  { header: "Deferred Revenue", get: (r) => r.deferredRevenue },
  { header: "Restriction Evidence", get: (r) => r.restrictionEvidence },
  { header: "Questions/Flags", get: (r) => r.questionsFlags },
  { header: "Notes", get: (r) => r.notes },
  { header: "Source File", get: (r) => r.sourceFile },
];

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Default range: the current calendar year to date. Finance narrows it further.
function defaultRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(now) };
}

export default function RevenueExtractor() {
  const { toast } = useToast();
  const initial = useMemo(defaultRange, []);
  // Draft inputs (the text fields) vs. the applied range that drives the query.
  const [draftStart, setDraftStart] = useState(initial.start);
  const [draftEnd, setDraftEnd] = useState(initial.end);
  const [range, setRange] = useState<{ start: string; end: string }>(initial);

  const params = { startDate: range.start, endDate: range.end };
  const { data, isLoading, isError, error } = useGetRevenueExtractorReport(
    params,
    {
      query: {
        queryKey: getGetRevenueExtractorReportQueryKey(params),
        enabled: !!range.start && !!range.end,
      },
    },
  );

  const rows = data?.rows ?? [];
  const disagreementCount = rows.filter((r) => r.codingDisagreement).length;

  const rangeInvalid =
    !!draftStart && !!draftEnd && draftStart > draftEnd;

  function applyRange() {
    if (!draftStart || !draftEnd) {
      toast({
        title: "Pick a date range",
        description: "Both a start and end date are required.",
        variant: "destructive",
      });
      return;
    }
    if (draftStart > draftEnd) {
      toast({
        title: "Invalid range",
        description: "The start date must be on or before the end date.",
        variant: "destructive",
      });
      return;
    }
    setRange({ start: draftStart, end: draftEnd });
  }

  function exportCsv() {
    if (rows.length === 0) {
      toast({
        title: "Nothing to export",
        description: "No rows in the current date range.",
      });
      return;
    }
    const header = COLUMNS.map((c) => csvCell(c.header)).join(",");
    const body = rows
      .map((r) => COLUMNS.map((c) => csvCell(c.get(r))).join(","))
      .join("\n");
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `revenue-extractor-${range.start}_to_${range.end}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6 max-w-[120rem]">
      <ListPageHeader
        title="Revenue Extractor"
        subtitle={
          <>
            One coded row per gift allocation for a transaction date range, plus a
            separate negative processor-fee line, across the finance team's 19
            columns. QuickBooks stays authoritative — rows where the CRM-derived
            coding disagrees with the linked QuickBooks snapshot are flagged. The
            Name column respects anonymous masking, and archived gifts are excluded.
          </>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rx-start" className="text-xs text-muted-foreground">
            Start date
          </Label>
          <Input
            id="rx-start"
            type="date"
            value={draftStart}
            max={draftEnd || undefined}
            onChange={(e) => setDraftStart(e.target.value)}
            className="w-44"
            data-testid="input-revenue-extractor-start"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rx-end" className="text-xs text-muted-foreground">
            End date
          </Label>
          <Input
            id="rx-end"
            type="date"
            value={draftEnd}
            min={draftStart || undefined}
            onChange={(e) => setDraftEnd(e.target.value)}
            className="w-44"
            data-testid="input-revenue-extractor-end"
          />
        </div>
        <Button
          onClick={applyRange}
          disabled={rangeInvalid}
          data-testid="button-revenue-extractor-apply"
        >
          Run report
        </Button>
        <Button
          variant="outline"
          onClick={exportCsv}
          disabled={rows.length === 0}
          data-testid="button-revenue-extractor-export"
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
        {rangeInvalid ? (
          <p className="text-xs text-destructive">
            The start date must be on or before the end date.
          </p>
        ) : null}
      </div>

      {/* Summary line */}
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span data-testid="text-revenue-extractor-count">
          {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
        </span>
        {disagreementCount > 0 ? (
          <Badge
            variant="outline"
            className="border-amber-400 text-amber-700"
            data-testid="badge-revenue-extractor-disagreements"
          >
            <AlertTriangle className="mr-1 h-3.5 w-3.5" />
            {disagreementCount} QuickBooks disagreement
            {disagreementCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <span className="sr-only">QuickBooks disagreement</span>
              </TableHead>
              {COLUMNS.map((c) => (
                <TableHead key={c.header} className="whitespace-nowrap">
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS.length + 1}
                  className="py-10 text-center text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS.length + 1}
                  className="py-10 text-center text-destructive"
                >
                  Failed to load: {(error as Error)?.message ?? "unknown error"}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS.length + 1}
                  className="py-10 text-center text-muted-foreground"
                >
                  No gift allocations in this date range.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <RevenueRow key={r.rowKey} row={r} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RevenueRow({ row }: { row: RevenueExtractorRow }) {
  return (
    <TableRow
      data-testid={`revenue-extractor-row-${row.rowKey}`}
      className={
        row.isFeeLine
          ? "bg-muted/30"
          : row.codingDisagreement
            ? "bg-amber-50/60 dark:bg-amber-950/20"
            : undefined
      }
    >
      <TableCell className="w-8 align-top">
        {row.codingDisagreement ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span data-testid={`revenue-extractor-disagreement-${row.rowKey}`}>
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p className="font-medium">CRM coding differs from QuickBooks</p>
                <p className="mt-1 text-xs">
                  QuickBooks is authoritative. Linked QuickBooks snapshot:
                </p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  <li>Object Code: {row.qbObjectCode ?? "—"}</li>
                  <li>Location: {row.qbLocation ?? "—"}</li>
                  <li>Class: {row.qbClass ?? "—"}</li>
                </ul>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </TableCell>
      {COLUMNS.map((c) => (
        <TableCell
          key={c.header}
          className={`whitespace-nowrap align-top ${c.className ?? ""}`}
        >
          {c.get(row) ?? ""}
        </TableCell>
      ))}
    </TableRow>
  );
}
