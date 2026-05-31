import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPeople,
  getListPeopleQueryKey,
  useBulkUpdatePeople,
  type ListPeopleParams,
  type CapacityRating,
  type Person,
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SavedViewsBar } from "@/components/saved-views-bar";
import { ColumnsMenu } from "@/components/columns-menu";
import { resolveColumns, type ColumnDef, type ColumnsState } from "@/lib/columns";
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
  "tier_1k_10k",
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
const PRIORITY_LABEL: Record<string, string> = { top: "Top", high: "High", medium: "Medium", low: "Low" };

// Lookups the column cell renderers close over. Bundled into a single
// context object so `buildColumns` stays a pure function of its inputs
// (easier to memoize, easier to read).
type ColCtx = {
  regionNames: Map<string, string>;
  userNames: Map<string, string>;
};

function buildColumns(ctx: ColCtx): ColumnDef<Person>[] {
  return [
    {
      key: "priority",
      label: "Priority star",
      header: <span className="sr-only">Priority</span>,
      thClassName: "w-8 pr-0",
      tdClassName: "w-8 pr-0",
      cell: (p) => <PriorityStar priority={p.priority} />,
    },
    {
      key: "name",
      label: "Name",
      required: true,
      tdClassName: "font-medium",
      cell: (p) => (
        <Link href={`/individuals/${p.id}`} className="block w-full">
          {personDisplayName(p)}
        </Link>
      ),
    },
    {
      key: "priorityTier",
      label: "Priority tier",
      cell: (p) =>
        p.priority ? (
          <Badge variant="outline">{PRIORITY_LABEL[p.priority] ?? p.priority}</Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "status",
      label: "Status",
      cell: (p) => (p.deceased ? <Badge variant="outline">Deceased</Badge> : "—"),
    },
    {
      key: "region",
      label: "Region",
      cell: (p) =>
        p.currentHomeRegionId
          ? (ctx.regionNames.get(p.currentHomeRegionId) ?? p.currentHomeRegionId)
          : "—",
    },
    {
      key: "capacity",
      label: "Capacity",
      cell: (p) => formatCapacity(p.capacityRating),
    },
    {
      key: "lastContacted",
      label: "Last contacted",
      cell: (p) => formatDateShort(p.lastContacted),
    },
    {
      key: "lifetimeGiving",
      label: "Lifetime giving",
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (p) => {
        const giving = p.lifetimeGiving;
        const hasGiving = giving != null && Number(giving) > 0;
        return hasGiving ? formatCurrency(giving) : "—";
      },
    },
    {
      key: "lastGift",
      label: "Last gift",
      cell: (p) => formatDateShort(p.mostRecentGiftDate),
    },
    {
      key: "openAsks",
      label: "Open asks",
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (p) => {
        const openAsks = p.openOpportunityCount ?? 0;
        return openAsks > 0 ? openAsks : "—";
      },
    },
    {
      key: "activeFunders",
      label: "Active funders / orgs",
      tdClassName: "text-xs text-muted-foreground max-w-[240px]",
      cell: (p) => {
        const activeFunders = p.activeFunderNames ?? [];
        if (activeFunders.length > 0)
          return activeFunders.map(formatFunderNameShort).join(", ");

        const activeOrgs = p.activeOrganizationNames ?? [];
        if (activeOrgs.length > 0)
          return (
            <span className="text-muted-foreground/70">
              {activeOrgs.join(", ")}
            </span>
          );

        const pastFunders = (p.pastFunderNames ?? []).map(formatFunderNameShort);
        const pastOrgs = p.pastOrganizationNames ?? [];
        const past = [...pastFunders, ...pastOrgs];
        if (past.length > 0)
          return (
            <span className="italic text-muted-foreground/50" title="Past role(s)">
              {past.join(", ")}
              <span className="not-italic ml-1 text-[10px] uppercase tracking-wide">past</span>
            </span>
          );

        return "—";
      },
    },
    {
      key: "owner",
      label: "Owner",
      tdClassName: "text-sm text-muted-foreground",
      cell: (p) =>
        p.ownerUserId
          ? (ctx.userNames.get(p.ownerUserId) ?? p.ownerUserId)
          : "—",
    },
    {
      key: "interestsAges",
      label: "Ages",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (p) => {
        const vals = p.interestsAges ?? [];
        return vals.length === 0 ? "—" : vals.join(", ");
      },
    },
    {
      key: "interestsThematic",
      label: "Themes",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (p) => {
        const vals = p.interestsThematic ?? [];
        return vals.length === 0 ? "—" : vals.join(", ");
      },
    },
    {
      key: "interestsGovModels",
      label: "Governance",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (p) => {
        const vals = p.interestsGovModels ?? [];
        return vals.length === 0 ? "—" : vals.join(", ");
      },
    },
    {
      key: "regionIds",
      label: "Regions",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (p) => {
        const ids = p.regionIds ?? [];
        if (ids.length === 0) return "—";
        return ids.map((id) => ctx.regionNames.get(id) ?? id).join(", ");
      },
    },
  ];
}

export default function Individuals() {
  // Filter state persists per-tab so back-navigation from a person
  // detail page restores the same filtered view.
  const [search, setSearch] = usePersistedState<string>("wf.list.people.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [deceasedSel, setDeceasedSel] = usePersistedState<string[]>("wf.list.people.deceased", []);
  const [capacityTiers, setCapacityTiers] = usePersistedState<string[]>("wf.list.people.capacity", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.people.owners", []);
  const [page, setPage] = usePersistedState<number>("wf.list.people.page", 1);
  // Column customization: null = use registry defaults. Shape is
  // round-tripped through saved views, so changes here also persist
  // per-view when the user saves one.
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    "wf.list.people.columns",
    null,
  );
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkMut = useBulkUpdatePeople();

  const ts = useTableState("individuals");
  const sortActive = ts.sort.key !== null;
  const params: ListPeopleParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
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

  const registry = useMemo(
    () => buildColumns({ regionNames, userNames }),
    [regionNames, userNames],
  );
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 1; // +1 for the checkbox column

  const CAPACITY_ORDER: Record<string, number> = {
    tier_1k_10k: 0, tier_10k_50k: 1, tier_50k_250k: 2, tier_250k_1m: 3, tier_1m_plus: 4,
  };
  const PRIORITY_ORDER: Record<string, number> = { top: 4, high: 3, medium: 2, low: 1 };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          priority: (r) => (r.priority === "top" ? 1 : 0),
          name: (r) => personDisplayName(r).toLowerCase(),
          status: (r) => (r.deceased ? 1 : 0),
          region: (r) =>
            r.currentHomeRegionId
              ? (regionNames.get(r.currentHomeRegionId) ?? r.currentHomeRegionId)
              : null,
          capacity: (r) =>
            r.capacityRating ? (CAPACITY_ORDER[r.capacityRating] ?? 0) : null,
          priorityTier: (r) =>
            r.priority ? (PRIORITY_ORDER[r.priority] ?? 0) : null,
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
  const pagedRows = useMemo(() => {
    if (!sortActive) return sortedRows;
    // Clamp page to the available range so a stale persisted page (or a
    // filter narrowing the dataset) doesn't render a blank table body.
    const maxPage = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), maxPage);
    return sortedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [sortActive, sortedRows, page]);

  const hasActiveFilters =
    !!search ||
    deceasedSel.length > 0 ||
    capacityTiers.length > 0 ||
    owners.length > 0;

  // ─── Saved views ─────────────────────────────────────────────────
  // The persisted view captures filters + sort + the user's column
  // config but deliberately omits `page` (saving "page 7" makes no
  // sense after the underlying data shifts) and column widths
  // (presentation, not data).
  type IndividualsView = {
    search: string;
    deceasedSel: string[];
    capacityTiers: string[];
    owners: string[];
    sort: SortState;
    columns: ColumnsState | null;
  };
  const currentView: IndividualsView = {
    search,
    deceasedSel,
    capacityTiers,
    owners,
    sort: ts.sort,
    columns: columnsState,
  };
  const clearAll = () => {
    setSearch("");
    setDeceasedSel([]);
    setCapacityTiers([]);
    setOwners([]);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
    selection.clear();
    // Clearing only resets filters + sort; we deliberately leave the
    // user's column config alone since it's a presentation preference
    // they tend to set once and forget.
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
      // Backwards-compat: views saved before this feature have no
      // `columns` field. Treat them as "default columns" so applying
      // doesn't accidentally hide anything.
      setColumnsState(s.columns ?? null);
      setPage(1);
      selection.clear();
    },
    isDefault: (s) =>
      !s.search &&
      (s.deceasedSel?.length ?? 0) === 0 &&
      (s.capacityTiers?.length ?? 0) === 0 &&
      (s.owners?.length ?? 0) === 0 &&
      (s.sort?.key ?? null) === null &&
      (s.columns ?? null) === null,
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
        canSave={hasActiveFilters || ts.sort.key !== null || columnsState !== null}
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
          includeBlank
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

        <div className="ml-auto">
          <ColumnsMenu
            registry={registry}
            state={columnsState}
            onChange={setColumnsState}
          />
        </div>
      </div>

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={
                    pagedRows.length > 0 &&
                    pagedRows.every((r) => selection.isSelected(r.id))
                  }
                  onCheckedChange={() => selection.toggleVisible(pagedRows.map((r) => r.id))}
                  aria-label="Select all people on this page"
                  data-testid="checkbox-select-all-people"
                />
              </TableHead>
              {visibleCols.map((c) => (
                <SortableTH
                  key={c.key}
                  colKey={c.sortKey ?? c.key}
                  sortable={c.sortable}
                  align={c.align}
                  className={c.thClassName}
                  {...ts}
                >
                  {c.header ?? c.label}
                </SortableTH>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load people."}
                </TableCell>
              </TableRow>
            ) : pagedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">
                  No people match these filters.
                </TableCell>
              </TableRow>
            ) : (
              pagedRows.map((p) => (
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
                  {visibleCols.map((c) => (
                    <TableCell key={c.key} className={c.tdClassName}>
                      {c.cell(p)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
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
