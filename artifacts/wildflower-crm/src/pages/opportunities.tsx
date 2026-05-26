import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useBulkUpdateOpportunitiesAndPledges,
  useListFiscalYears,
  useListEntities,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityStatus,
  type OpportunityStage,
  type OpportunityType,
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { OPPORTUNITIES_BULK_FIELDS } from "@/lib/bulk-fields";
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
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";

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
  // All enum filters are multi-select. Status defaults to a single-item
  // array when `defaultStatus` is provided (e.g. the dashboard pre-filters
  // to "open"), and is forced to `[lockedStatus]` when locked (pledges view).
  const defaultStatusArr = defaultStatus ? [defaultStatus] : [];
  const [statuses, setStatuses] = useState<string[]>(defaultStatusArr);
  const [stages, setStages] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [fiscalYears, setFiscalYears] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkMut = useBulkUpdateOpportunitiesAndPledges();
  // Lookup map so the Entities column can render slug -> human name
  // without firing one fetch per row. Same pattern as gifts.tsx.
  const entitiesQ = useListEntities();
  const entityNameById = useMemo(
    () => new Map((entitiesQ.data ?? []).map((e) => [e.id, e.name])),
    [entitiesQ.data],
  );

  // Sort every array filter before serializing into request params so
  // the react-query cache key is stable regardless of the order the user
  // clicked checkboxes in (`['a','b']` and `['b','a']` would otherwise
  // produce distinct keys / refetches).
  const effectiveStatuses = lockedStatus
    ? [lockedStatus]
    : [...statuses].sort();

  const params: ListOpportunitiesAndPledgesParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(effectiveStatuses.length > 0
      ? { status: effectiveStatuses as OpportunityStatus[] }
      : {}),
    ...(stages.length > 0 ? { stage: [...stages].sort() as OpportunityStage[] } : {}),
    ...(types.length > 0 ? { type: [...types].sort() as OpportunityType[] } : {}),
    ...(fiscalYears.length > 0 ? { fiscalYear: [...fiscalYears].sort() } : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
  };

  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(params, {
    query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) },
  });

  const rows = data?.data ?? [];

  const ts = useTableState("opportunities");
  const userNames = useUserNameMap();
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
          fy: (r) => (r.coveredFiscalYears ?? []).join(",") || null,
          projectedClose: (r) => r.projectedCloseDate ?? null,
          owner: (r) =>
            r.ownerUserId
              ? (userNames.get(r.ownerUserId) ?? r.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [rows, ts.sort, userNames],
  );
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const isPledgeView = lockedStatus === "won";

  // Determine "is anything filtered beyond default?" for the Clear button.
  const sameDefaultStatus =
    statuses.length === defaultStatusArr.length &&
    [...statuses].sort().join(",") === [...defaultStatusArr].sort().join(",");
  const hasActiveFilters =
    !!search ||
    (!lockedStatus && !sameDefaultStatus) ||
    stages.length > 0 ||
    types.length > 0 ||
    fiscalYears.length > 0 ||
    owners.length > 0;

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
            onChange={(e) => { setSearch(e.target.value); setPage(1); selection.clear(); }}
            aria-label="Search opportunities by name"
            data-testid="input-search-opportunities"
          />
        </div>
        {!lockedStatus && (
          <MultiFilterSelect
            label="Status"
            selected={statuses}
            onChange={(v) => { setStatuses(v); setPage(1); selection.clear(); }}
            options={STATUSES}
            testId="select-opp-status"
          />
        )}
        <MultiFilterSelect
          label="Stage"
          selected={stages}
          onChange={(v) => { setStages(v); setPage(1); selection.clear(); }}
          options={STAGES}
          testId="select-opp-stage"
        />
        <MultiFilterSelect
          label="Type"
          selected={types}
          onChange={(v) => { setTypes(v); setPage(1); selection.clear(); }}
          options={TYPES}
          testId="select-opp-type"
        />
        <FiscalYearMultiSelect
          selected={fiscalYears}
          onChange={(v) => { setFiscalYears(v); setPage(1); selection.clear(); }}
        />
        <OwnerMultiFilter
          selected={owners}
          onChange={(v) => { setOwners(v); setPage(1); selection.clear(); }}
          testId="select-opp-owner"
        />
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              if (!lockedStatus) setStatuses(defaultStatusArr);
              setStages([]);
              setTypes([]);
              setFiscalYears([]);
              setOwners([]);
              setPage(1);
              selection.clear();
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
              <TableHead className="w-8">
                <Checkbox
                  checked={
                    sortedRows.length > 0 &&
                    sortedRows.every((r) => selection.isSelected(r.id))
                  }
                  onCheckedChange={() => selection.toggleVisible(sortedRows.map((r) => r.id))}
                  aria-label="Select all opportunities on this page"
                  data-testid="checkbox-select-all-opps"
                />
              </TableHead>
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
              <SortableTH colKey="entities" sortable={false} {...ts}>Entities</SortableTH>
              <SortableTH colKey="fy" {...ts}>FY</SortableTH>
              <SortableTH colKey="projectedClose" {...ts}>Projected close</SortableTH>
              <SortableTH colKey="owner" {...ts}>Owner</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={11} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : sortedRows.length === 0 ? (
              <TableRow><TableCell colSpan={11} className="text-center h-24 text-muted-foreground">No opportunities match these filters.</TableCell></TableRow>
            ) : (
              sortedRows.map((o) => {
                const coveredFys = (o.coveredFiscalYears ?? []).map((y) => y.toUpperCase());
                const entities = (o.entityIds ?? []).map(
                  (id) => entityNameById.get(id) ?? id,
                );
                return (
                  <TableRow key={o.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-opp-${o.id}`}>
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selection.isSelected(o.id)}
                        onCheckedChange={() => selection.toggle(o.id)}
                        aria-label={`Select ${o.name ?? o.id}`}
                        data-testid={`checkbox-select-${o.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`${basePath}/${o.id}`} className="block w-full">{o.name ?? `Untitled ${o.id}`}</Link>
                    </TableCell>
                    <TableCell>
                      <DonorCell
                        funderId={o.funderId}
                        funderName={o.funderName}
                        funderIsPriority={o.funderIsPriority}
                        householdId={o.householdId}
                        householdName={o.householdName}
                        individualGiverPersonId={o.individualGiverPersonId}
                        individualGiverPersonName={o.individualGiverPersonName}
                        individualGiverPersonIsPriority={o.individualGiverPersonIsPriority}
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
                    <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                      {entities.length === 0 ? "—" : entities.join(", ")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {coveredFys.length === 0 ? "—" : coveredFys.join(", ")}
                    </TableCell>
                    <TableCell>{formatDateShort(o.projectedCloseDate)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {o.ownerUserId
                        ? (userNames.get(o.ownerUserId) ?? o.ownerUserId)
                        : "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <BulkActionBar
        count={selection.count}
        onEdit={() => setBulkOpen(true)}
        onClear={selection.clear}
        entityNoun="opportunity"
      />
      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        entityNoun="opportunity"
        selectedIds={selection.selectedIds}
        fields={OPPORTUNITIES_BULK_FIELDS}
        invalidateKeys={[getListOpportunitiesAndPledgesQueryKey()]}
        onSubmit={async (patch) =>
          bulkMut.mutateAsync({
            data: { ids: selection.selectedIds, patch },
          })
        }
        onDone={(r) => {
          selection.removeMany(r.succeededIds);
        }}
      />

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
// the top, then newest → oldest FY, and clipped to a sensible window.
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
    const currentFyEnd =
      new Date().getUTCMonth() >= 6 ? currentYear + 1 : currentYear;
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
      return b.id.localeCompare(a.id);
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
