import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPeople,
  getListPeopleQueryKey,
  useBulkUpdatePeople,
  type ListPeopleParams,
  type CapacityRating,
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SavedViewsBar } from "@/components/saved-views-bar";
import type { SortState } from "@/lib/table-helpers";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { PEOPLE_BULK_FIELDS } from "@/lib/bulk-fields";
import { Checkbox } from "@/components/ui/checkbox";
import {
  formatCapacity,
  formatCurrency,
  formatDateShort,
  formatFunderNameShort,
} from "@/lib/format";
import { useDebounce } from "@/hooks/use-debounce";
import { useRegionNameMap } from "@/components/region-picker";
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
import { CreatePersonDialog } from "@/components/create-person-dialog";
import { PriorityStar } from "@/components/priority-star";
import {
  MultiFilterSelect,
  type MultiFilterOption,
} from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { personDisplayName } from "@/lib/person";

const PAGE_SIZE = 50;
// Capacity column + filter — same enum + labels we use on funders, just
// surfaced on individuals now that the field exists on people too.
const CAPACITY_TIERS: CapacityRating[] = [
  "tier_10k_50k",
  "tier_50k_250k",
  "tier_250k_1m",
  "tier_1m_plus",
];
// Living/Deceased is conceptually a boolean filter — but for UI
// consistency with every other filter on the page, we surface it as a
// multi-select with both options. Picking 0 or 2 options is equivalent
// to "no filter" and we omit the query param entirely; picking exactly
// one sends the single boolean to the server.
const DECEASED_OPTIONS: MultiFilterOption[] = [
  { value: "false", label: "Living" },
  { value: "true", label: "Deceased" },
];
const COL_SPAN = 12;

export default function Individuals() {
  // Filter state persists per-tab so back-navigation from a person
  // detail page restores the same filtered view.
  const [search, setSearch] = usePersistedState<string>("wf.list.people.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [deceasedSel, setDeceasedSel] = usePersistedState<string[]>("wf.list.people.deceased", []);
  const [capacityTiers, setCapacityTiers] = usePersistedState<string[]>("wf.list.people.capacity", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.people.owners", []);
  const [page, setPage] = usePersistedState<number>("wf.list.people.page", 1);
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkMut = useBulkUpdatePeople();

  const params: ListPeopleParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    // Only send the boolean when exactly one option is picked. 0 or 2 = unfiltered.
    ...(deceasedSel.length === 1
      ? { deceased: deceasedSel[0] === "true" }
      : {}),
    ...(capacityTiers.length > 0
      ? { capacityRating: [...capacityTiers].sort() as CapacityRating[] }
      : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
  };

  const { data, isLoading, isError, error } = useListPeople(params, {
    query: { queryKey: getListPeopleQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const regionNames = useRegionNameMap();
  const userNames = useUserNameMap();

  const ts = useTableState("individuals");
  const CAPACITY_ORDER: Record<string, number> = {
    tier_10k_50k: 1, tier_50k_250k: 2, tier_250k_1m: 3, tier_1m_plus: 4,
  };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          priority: (r) => (r.isPriority ? 1 : 0),
          name: (r) => personDisplayName(r).toLowerCase(),
          status: (r) => (r.deceased ? 1 : 0),
          region: (r) =>
            r.currentHomeRegionId
              ? (regionNames.get(r.currentHomeRegionId) ?? r.currentHomeRegionId)
              : null,
          capacity: (r) =>
            r.capacityRating ? (CAPACITY_ORDER[r.capacityRating] ?? 0) : null,
          lastContacted: (r) => r.lastContacted ?? null,
          lifetimeGiving: (r) =>
            r.lifetimeGiving != null ? Number(r.lifetimeGiving) : null,
          lastGift: (r) => r.mostRecentGiftDate ?? null,
          openAsks: (r) => r.openOpportunityCount ?? null,
          activeFunders: (r) => (r.activeFunderNames ?? []).length || null,
          owner: (r) =>
            r.ownerUserId
              ? (userNames.get(r.ownerUserId) ?? r.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [rows, ts.sort, regionNames, userNames],
  );

  const hasActiveFilters =
    !!search ||
    deceasedSel.length > 0 ||
    capacityTiers.length > 0 ||
    owners.length > 0;

  // ─── Saved views ─────────────────────────────────────────────────
  // The persisted view captures filters + sort but deliberately omits
  // `page` (saving "page 7" makes no sense after the underlying data
  // shifts) and column widths (pure presentation).
  type IndividualsView = {
    search: string;
    deceasedSel: string[];
    capacityTiers: string[];
    owners: string[];
    sort: SortState;
  };
  const currentView: IndividualsView = {
    search,
    deceasedSel,
    capacityTiers,
    owners,
    sort: ts.sort,
  };
  const clearAll = () => {
    setSearch("");
    setDeceasedSel([]);
    setCapacityTiers([]);
    setOwners([]);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
    selection.clear();
  };
  const viewsCtrl = useSavedViews<IndividualsView>({
    listKey: "individuals",
    current: currentView,
    apply: (s) => {
      setSearch(s.search ?? "");
      setDeceasedSel(s.deceasedSel ?? []);
      setCapacityTiers(s.capacityTiers ?? []);
      setOwners(s.owners ?? []);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      setPage(1);
      selection.clear();
    },
    isDefault: (s) =>
      !s.search &&
      (s.deceasedSel?.length ?? 0) === 0 &&
      (s.capacityTiers?.length ?? 0) === 0 &&
      (s.owners?.length ?? 0) === 0 &&
      (s.sort?.key ?? null) === null,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Individuals
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
          </p>
        </div>
        <CreatePersonDialog />
      </div>

      <SavedViewsBar
        controller={viewsCtrl}
        canSave={hasActiveFilters || ts.sort.key !== null}
        onClearAll={clearAll}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <Input
            placeholder="Search by name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
              selection.clear();
            }}
            aria-label="Search people by name"
            data-testid="input-search-people"
          />
        </div>

        <MultiFilterSelect
          label="Status"
          selected={deceasedSel}
          onChange={(v) => { setDeceasedSel(v); setPage(1); selection.clear(); }}
          options={DECEASED_OPTIONS}
          testId="select-deceased"
        />
        <MultiFilterSelect
          label="Capacity"
          selected={capacityTiers}
          onChange={(v) => { setCapacityTiers(v); setPage(1); selection.clear(); }}
          options={CAPACITY_TIERS.map((t) => ({ value: t, label: formatCapacity(t) ?? t }))}
          testId="select-capacity"
        />
        <OwnerMultiFilter
          selected={owners}
          onChange={(v) => { setOwners(v); setPage(1); selection.clear(); }}
          testId="select-person-owner"
        />

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setDeceasedSel([]);
              setCapacityTiers([]);
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
                  aria-label="Select all people on this page"
                  data-testid="checkbox-select-all-people"
                />
              </TableHead>
              <SortableTH colKey="priority" {...ts}><span className="sr-only">Priority</span></SortableTH>
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="status" {...ts}>Status</SortableTH>
              <SortableTH colKey="region" {...ts}>Region</SortableTH>
              <SortableTH colKey="capacity" {...ts}>Capacity</SortableTH>
              <SortableTH colKey="lastContacted" {...ts}>Last contacted</SortableTH>
              <SortableTH colKey="lifetimeGiving" align="right" {...ts}>Lifetime giving</SortableTH>
              <SortableTH colKey="lastGift" {...ts}>Last gift</SortableTH>
              <SortableTH colKey="openAsks" align="right" {...ts}>Open asks</SortableTH>
              <SortableTH colKey="activeFunders" {...ts}>Active funders</SortableTH>
              <SortableTH colKey="owner" {...ts}>Owner</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} className="text-center h-24 text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load people."}
                </TableCell>
              </TableRow>
            ) : sortedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} className="text-center h-24 text-muted-foreground">
                  No people match these filters.
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((p) => {
                const giving = p.lifetimeGiving;
                const hasGiving = giving != null && Number(giving) > 0;
                const openAsks = p.openOpportunityCount ?? 0;
                const funders = p.activeFunderNames ?? [];
                return (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    data-testid={`row-person-${p.id}`}
                  >
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selection.isSelected(p.id)}
                        onCheckedChange={() => selection.toggle(p.id)}
                        aria-label={`Select ${personDisplayName(p)}`}
                        data-testid={`checkbox-select-${p.id}`}
                      />
                    </TableCell>
                    <TableCell className="w-8 pr-0">
                      <PriorityStar kind="person" id={p.id} isPriority={p.isPriority} />
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/individuals/${p.id}`} className="block w-full">
                        {personDisplayName(p)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {p.deceased ? <Badge variant="outline">Deceased</Badge> : "—"}
                    </TableCell>
                    <TableCell>
                      {p.currentHomeRegionId
                        ? (regionNames.get(p.currentHomeRegionId) ?? p.currentHomeRegionId)
                        : "—"}
                    </TableCell>
                    <TableCell>{formatCapacity(p.capacityRating)}</TableCell>
                    <TableCell>{formatDateShort(p.lastContacted)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hasGiving ? formatCurrency(giving) : "—"}
                    </TableCell>
                    <TableCell>{formatDateShort(p.mostRecentGiftDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {openAsks > 0 ? openAsks : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[240px]">
                      {funders.length === 0
                        ? "—"
                        : funders.map(formatFunderNameShort).join(", ")}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.ownerUserId
                        ? (userNames.get(p.ownerUserId) ?? p.ownerUserId)
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
        entityNoun="person"
      />
      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        entityNoun="person"
        selectedIds={selection.selectedIds}
        fields={PEOPLE_BULK_FIELDS}
        invalidateKeys={[getListPeopleQueryKey()]}
        onSubmit={async (patch) =>
          bulkMut.mutateAsync({
            data: { ids: selection.selectedIds, patch },
          })
        }
        onDone={(r) => {
          // Drop succeeded rows from the selection so failures stay
          // selected for retry / inspection.
          selection.removeMany(r.succeededIds);
        }}
      />

      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPage((p) => Math.max(1, p - 1));
                }}
                aria-disabled={page <= 1}
                className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>
                {page} / {totalPages}
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPage((p) => Math.min(totalPages, p + 1));
                }}
                aria-disabled={page >= totalPages}
                className={page >= totalPages ? "pointer-events-none opacity-50" : undefined}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
