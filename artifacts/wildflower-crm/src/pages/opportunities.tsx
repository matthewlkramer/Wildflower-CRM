import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useListFiscalYears,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityStatus,
  type OpportunityStage,
  type OpportunityType,
} from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown } from "lucide-react";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { DonorCell } from "@/components/donor-cell";

const STATUSES: OpportunityStatus[] = ["open", "won", "dormant", "lost"];
const STAGES: OpportunityStage[] = [
  "cold_lead",
  "warm_lead",
  "in_conversation",
  "convince",
  "conditional_commitment",
  "probable_renewal",
  "verbal_commitment",
  "written_commitment",
  "cash_in",
];
const TYPES: OpportunityType[] = ["solicitation", "renewal", "open_application"];

const PAGE_SIZE = 50;
const ANY = "_any";

type Props = {
  title?: string;
  /** When set, locks the status filter to this value and hides the control. */
  lockedStatus?: OpportunityStatus;
  /** Default for the status filter when not locked. */
  defaultStatus?: OpportunityStatus | null;
  basePath?: string;
};

export default function Opportunities({
  title = "Opportunities",
  lockedStatus,
  defaultStatus = null,
  basePath = "/opportunities",
}: Props) {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [status, setStatus] = useState<string>(defaultStatus ?? ANY);
  const [stage, setStage] = useState<string>(ANY);
  const [type, setType] = useState<string>(ANY);
  const [fiscalYears, setFiscalYears] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const effectiveStatus = lockedStatus ?? (status !== ANY ? (status as OpportunityStatus) : undefined);

  const params: ListOpportunitiesAndPledgesParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(effectiveStatus ? { status: effectiveStatus } : {}),
    ...(stage !== ANY ? { stage: stage as OpportunityStage } : {}),
    ...(type !== ANY ? { type: type as OpportunityType } : {}),
    // Sort the FY slugs so the react-query cache key is stable
    // regardless of the order the user clicked checkboxes in
    // (`['fy2026','future']` and `['future','fy2026']` would
    // otherwise produce distinct keys / refetches).
    ...(fiscalYears.length > 0 ? { fiscalYear: [...fiscalYears].sort() } : {}),
  };

  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(params, {
    query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) },
  });

  const rows = data?.data ?? [];

  const ts = useTableState("opportunities");
  const STAGE_ORDER: Record<string, number> = {
    cold_lead: 1, warm_lead: 2, in_conversation: 3, convince: 4,
    conditional_commitment: 5, probable_renewal: 6, verbal_commitment: 7,
    written_commitment: 8, cash_in: 9,
  };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => (r.name ?? "").toLowerCase(),
          donor: (r) =>
            (r.funderName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
          stage: (r) => (r.stage ? (STAGE_ORDER[r.stage] ?? 0) : null),
          status: (r) => r.status ?? null,
          ask: (r) => (r.askAmount != null ? Number(r.askAmount) : null),
          coveredFys: (r) => (r.coveredFiscalYears ?? []).join(",") || null,
          awarded: (r) => (r.awardedAmount != null ? Number(r.awardedAmount) : null),
          // FY is the rolled-up set of grant years from child
          // pledge_allocations; sort by the earliest (or join) so
          // multi-year asks land predictably.
          fy: (r) => (r.coveredFiscalYears ?? []).join(",") || null,
          projectedClose: (r) => r.projectedCloseDate ?? null,
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Pledges (status='won') trade the Ask column for Covered FYs, since
  // by the time something is won the ask is historical and the
  // grant-year coverage is what fundraising actually wants to see.
  const isPledgeView = lockedStatus === "won";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <Input
            placeholder="Search by name…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            aria-label="Search opportunities by name"
            data-testid="input-search-opportunities"
          />
        </div>
        {!lockedStatus && (
          <FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUSES} testId="select-opp-status" />
        )}
        <FilterSelect label="Stage" value={stage} onChange={(v) => { setStage(v); setPage(1); }} options={STAGES} testId="select-opp-stage" />
        <FilterSelect label="Type" value={type} onChange={(v) => { setType(v); setPage(1); }} options={TYPES} testId="select-opp-type" />
        <FiscalYearMultiSelect
          selected={fiscalYears}
          onChange={(v) => { setFiscalYears(v); setPage(1); }}
        />
        {(search || (!lockedStatus && status !== (defaultStatus ?? ANY)) || stage !== ANY || type !== ANY || fiscalYears.length > 0) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              if (!lockedStatus) setStatus(defaultStatus ?? ANY);
              setStage(ANY);
              setType(ANY);
              setFiscalYears([]);
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="donor" {...ts}>Donor</SortableTH>
              <SortableTH colKey="stage" {...ts}>Stage</SortableTH>
              <SortableTH colKey="status" {...ts}>Status</SortableTH>
              {isPledgeView ? (
                <SortableTH colKey="coveredFys" {...ts}>Covered FYs</SortableTH>
              ) : (
                <SortableTH colKey="ask" align="right" {...ts}>Ask</SortableTH>
              )}
              <SortableTH colKey="awarded" align="right" {...ts}>Awarded</SortableTH>
              <SortableTH colKey="fy" {...ts}>FY</SortableTH>
              <SortableTH colKey="projectedClose" {...ts}>Projected close</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : sortedRows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center h-24 text-muted-foreground">No opportunities match these filters.</TableCell></TableRow>
            ) : (
              sortedRows.map((o) => {
                // FY column reflects the grant years on the child
                // pledge_allocations (the opp itself no longer carries
                // a fiscal_year column). Each entry is an FY slug like
                // "fy26"; uppercase for display.
                const coveredFys = (o.coveredFiscalYears ?? []).map((y) => y.toUpperCase());
                return (
                  <TableRow key={o.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-opp-${o.id}`}>
                    <TableCell className="font-medium">
                      <Link href={`${basePath}/${o.id}`} className="block w-full">{o.name ?? `Untitled ${o.id}`}</Link>
                    </TableCell>
                    <TableCell>
                      <DonorCell
                        funderId={o.funderId}
                        funderName={o.funderName}
                        householdId={o.householdId}
                        householdName={o.householdName}
                        individualGiverPersonId={o.individualGiverPersonId}
                        individualGiverPersonName={o.individualGiverPersonName}
                      />
                    </TableCell>
                    <TableCell>{formatEnum(o.stage)}</TableCell>
                    <TableCell>
                      {o.status ? <Badge variant={o.status === "won" ? "default" : "outline"}>{formatEnum(o.status)}</Badge> : "—"}
                    </TableCell>
                    {isPledgeView ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {coveredFys.length === 0 ? "—" : coveredFys.join(", ")}
                      </TableCell>
                    ) : (
                      <TableCell className="text-right tabular-nums">{formatCurrency(o.askAmount)}</TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{formatCurrency(o.awardedAmount)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {coveredFys.length === 0 ? "—" : coveredFys.join(", ")}
                    </TableCell>
                    <TableCell>{formatDateShort(o.projectedCloseDate)}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)); }} aria-disabled={page <= 1} className={page <= 1 ? "pointer-events-none opacity-50" : undefined} />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>{page} / {totalPages}</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#" onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(totalPages, p + 1)); }} aria-disabled={page >= totalPages} className={page >= totalPages ? "pointer-events-none opacity-50" : undefined} />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}

// Multi-select dropdown for the `fiscalYear` filter. Options are
// pulled from the fiscal-years table (slugs like `fy2026`, plus the
// special `future` slug). The list is sorted with "Future" pinned at
// the top, then newest → oldest FY, and clipped to a sensible window
// (everything between the earliest grant_year present in the data
// and a few years past current) — the full table goes out to FY2050
// which is noise on a filter UI.
function FiscalYearMultiSelect({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const { data: allFys } = useListFiscalYears();
  const [open, setOpen] = useState(false);

  const options = useMemo(() => {
    const rows = allFys ?? [];
    const currentYear = new Date().getUTCFullYear();
    // FY ends Jun 30; if we're past June we're in the next FY.
    const currentFyEnd =
      new Date().getUTCMonth() >= 6 ? currentYear + 1 : currentYear;
    // Show FY2016 through current+3, plus the "future" sentinel.
    const visible = rows.filter((r) => {
      if (r.id === "future") return true;
      const m = /^fy(\d{4})$/.exec(r.id);
      if (!m) return false;
      const yr = Number(m[1]);
      return yr >= 2016 && yr <= currentFyEnd + 3;
    });
    visible.sort((a, b) => {
      if (a.id === "future") return -1;
      if (b.id === "future") return 1;
      return b.id.localeCompare(a.id); // newest first
    });
    return visible;
  }, [allFys]);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  const label =
    selected.length === 0
      ? "Any"
      : selected.length === 1
        ? (allFys?.find((r) => r.id === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        Fiscal year
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-label="Fiscal year"
            className="w-[200px] justify-between font-normal"
            data-testid="select-opp-fiscal-year"
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[220px] p-2" align="start">
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {options.length === 0 ? (
              <div className="text-sm text-muted-foreground px-2 py-1">
                Loading…
              </div>
            ) : (
              options.map((opt) => {
                const checked = selected.includes(opt.id);
                return (
                  <label
                    key={opt.id}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-sm"
                    data-testid={`option-fy-${opt.id}`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(opt.id)}
                    />
                    <span>{opt.label}</span>
                  </label>
                );
              })
            )}
          </div>
          {selected.length > 0 && (
            <div className="mt-2 pt-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => onChange([])}
              >
                Clear
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FilterSelect({
  label, value, onChange, options, testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  testId: string;
}) {
  const inputId = `filter-${testId}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={inputId} className="w-[170px]" aria-label={label} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>{formatEnum(o)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
