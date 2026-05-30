import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListFunders,
  getListFundersQueryKey,
  useBulkUpdateFunders,
  type ListFundersParams,
  type FundingEntitySubtype,
  type ConnectionStatus,
  type ActiveStatus,
  type Priority,
  type Funder,
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
import { FUNDERS_BULK_FIELDS } from "@/lib/bulk-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCapacity, formatCurrency, formatEnum, formatFunderNameShort } from "@/lib/format";
import { useDebounce } from "@/hooks/use-debounce";
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
import { CreateFunderDialog } from "@/components/create-funder-dialog";
import { PriorityStar } from "@/components/priority-star";
import { MultiFilterSelect } from "@/components/multi-filter-select";
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

const SUBTYPES: FundingEntitySubtype[] = [
  "family_foundation",
  "institutional_foundation",
  "corporate_foundation",
  "community_foundation",
  "bank_foundation",
  "family_office_trust",
  "intermediary",
  "government",
  "nonprofit",
  "corporation",
  "capital_provider",
  "philanthropic_advisor",
  "cdfi",
  "education_forprofit",
  "competition",
  "public_private",
  "daf_platform",
  "platform",
];

// Subtypes excluded from the default Subtype filter. Fundraising users
// almost never care about these in day-to-day list views; they can still
// opt in by toggling them on (or clicking Clear and reselecting).
const DEFAULT_EXCLUDED_SUBTYPES: FundingEntitySubtype[] = [
  "nonprofit",
  "education_forprofit",
  "corporation",
  "daf_platform",
  "platform",
  "capital_provider",
];
const DEFAULT_SUBTYPES: FundingEntitySubtype[] = SUBTYPES.filter(
  (s) => !DEFAULT_EXCLUDED_SUBTYPES.includes(s),
);

const ACTIVE_STATUSES: ActiveStatus[] = ["active", "defunct", "spenddown"];
const DEFAULT_ACTIVE_STATUSES: ActiveStatus[] = ["active", "spenddown"];
const CONNECTION_STATUSES: ConnectionStatus[] = [
  "connected",
  "have_a_connector",
  "no_connection",
];
const PRIORITIES: Priority[] = ["top", "high", "medium", "low"];

const PAGE_SIZE = 50;
const PRIORITY_LABEL: Record<string, string> = { top: "Top", high: "High", medium: "Medium", low: "Low" };

type ColCtx = {
  userNames: Map<string, string>;
};

function buildColumns(ctx: ColCtx): ColumnDef<Funder>[] {
  return [
    {
      key: "priority",
      label: "Priority star",
      header: <span className="sr-only">Priority</span>,
      thClassName: "w-8 pr-0",
      tdClassName: "w-8 pr-0",
      cell: (f) => <PriorityStar priority={f.priority} />,
    },
    {
      key: "name",
      label: "Name",
      required: true,
      tdClassName: "font-medium",
      cell: (f) => (
        <Link href={`/funding-entities/${f.id}`} className="block w-full">
          {formatFunderNameShort(f.name)}
        </Link>
      ),
    },
    {
      key: "priorityTier",
      label: "Priority tier",
      cell: (f) =>
        f.priority ? (
          <Badge variant="outline">{PRIORITY_LABEL[f.priority] ?? f.priority}</Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "subtype",
      label: "Subtype",
      cell: (f) => formatEnum(f.fundingEntitySubtype),
    },
    {
      key: "active",
      label: "Active",
      cell: (f) =>
        f.activeStatus ? (
          <Badge variant={f.activeStatus === "active" ? "default" : "outline"}>
            {formatEnum(f.activeStatus)}
          </Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "connection",
      label: "Connection",
      cell: (f) => formatEnum(f.connectionStatus),
    },
    {
      key: "enthusiasm",
      label: "Enthusiasm",
      cell: (f) => formatEnum(f.enthusiasm),
    },
    {
      key: "strategicAlignment",
      label: "Strategic alignment",
      cell: (f) => formatEnum(f.strategicAlignment),
    },
    {
      key: "capacity",
      label: "Capacity",
      cell: (f) => formatCapacity(f.capacityRating),
    },
    {
      key: "primaryContact",
      label: "Primary contact",
      cell: (f) =>
        f.primaryContactPersonId ? (
          <Link
            href={`/individuals/${f.primaryContactPersonId}`}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {f.primaryContactPersonName ?? f.primaryContactPersonId}
          </Link>
        ) : (
          "—"
        ),
    },
    {
      key: "lifetimeGiving",
      label: "Lifetime giving",
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (f) => {
        const hasGiving = f.lifetimeGiving != null && Number(f.lifetimeGiving) > 0;
        return hasGiving ? formatCurrency(f.lifetimeGiving) : "—";
      },
    },
    {
      key: "openAsks",
      label: "Open asks",
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (f) => {
        const openAsks = f.openOpportunityCount ?? 0;
        return openAsks > 0 ? openAsks : "—";
      },
    },
    {
      key: "owner",
      label: "Owner",
      tdClassName: "text-sm text-muted-foreground",
      cell: (f) =>
        f.ownerUserId ? (ctx.userNames.get(f.ownerUserId) ?? f.ownerUserId) : "—",
    },
  ];
}

export default function FundingEntities() {
  // Filter state persists per-tab so back-navigation from a funder
  // detail restores the same filtered view.
  const [search, setSearch] = usePersistedState<string>("wf.list.funders.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [subtypes, setSubtypes] = usePersistedState<string[]>("wf.list.funders.subtypes", DEFAULT_SUBTYPES);
  const [activeStatuses, setActiveStatuses] = usePersistedState<string[]>("wf.list.funders.activeStatuses", DEFAULT_ACTIVE_STATUSES);
  const [connectionStatuses, setConnectionStatuses] = usePersistedState<string[]>("wf.list.funders.connectionStatuses", []);
  const [priorities, setPriorities] = usePersistedState<string[]>("wf.list.funders.priorities", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.funders.owners", []);
  const [page, setPage] = usePersistedState<number>("wf.list.funders.page", 1);
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    "wf.list.funders.columns",
    null,
  );
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkMut = useBulkUpdateFunders();

  const ts = useTableState("funding-entities");
  const sortActive = ts.sort.key !== null;
  const params: ListFundersParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(subtypes.length > 0 ? { subtype: [...subtypes].sort() as FundingEntitySubtype[] } : {}),
    ...(activeStatuses.length > 0
      ? { activeStatus: [...activeStatuses].sort() as ActiveStatus[] }
      : {}),
    ...(connectionStatuses.length > 0
      ? { connectionStatus: [...connectionStatuses].sort() as ConnectionStatus[] }
      : {}),
    ...(priorities.length > 0
      ? { priority: [...priorities].sort() as Priority[] }
      : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
  };

  const { data, isLoading, isError, error } = useListFunders(params, {
    query: { queryKey: getListFundersQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const userNames = useUserNameMap();
  const registry = useMemo(() => buildColumns({ userNames }), [userNames]);
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 1;

  const CAPACITY_ORDER: Record<string, number> = {
    tier_10k_50k: 1, tier_50k_250k: 2, tier_250k_1m: 3, tier_1m_plus: 4,
  };
  const PRIORITY_ORDER: Record<string, number> = { top: 4, high: 3, medium: 2, low: 1 };
  const ALIGNMENT_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          priority: (r) => (r.priority === "top" ? 1 : 0),
          name: (r) => formatFunderNameShort(r.name).toLowerCase(),
          subtype: (r) => r.fundingEntitySubtype ?? null,
          active: (r) => r.activeStatus ?? null,
          connection: (r) => r.connectionStatus ?? null,
          enthusiasm: (r) => r.enthusiasm ?? null,
          capacity: (r) =>
            r.capacityRating ? (CAPACITY_ORDER[r.capacityRating] ?? 0) : null,
          priorityTier: (r) =>
            r.priority ? (PRIORITY_ORDER[r.priority] ?? 0) : null,
          strategicAlignment: (r) =>
            r.strategicAlignment ? (ALIGNMENT_ORDER[r.strategicAlignment] ?? 0) : null,
          primaryContact: (r) => r.primaryContactPersonName?.toLowerCase() ?? null,
          lifetimeGiving: (r) =>
            r.lifetimeGiving != null ? Number(r.lifetimeGiving) : null,
          openAsks: (r) => r.openOpportunityCount ?? null,
          owner: (r) =>
            r.ownerUserId
              ? (userNames.get(r.ownerUserId) ?? r.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [rows, ts.sort, userNames],
  );
  const pagedRows = useMemo(() => {
    if (!sortActive) return sortedRows;
    const maxPage = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), maxPage);
    return sortedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [sortActive, sortedRows, page]);

  const sortedDefaultActiveStatuses = [...DEFAULT_ACTIVE_STATUSES].sort().join(",");
  const sameDefaultActiveStatuses =
    [...activeStatuses].sort().join(",") === sortedDefaultActiveStatuses;
  const sortedDefaultSubtypes = [...DEFAULT_SUBTYPES].sort().join(",");
  const sameDefaultSubtypes =
    [...subtypes].sort().join(",") === sortedDefaultSubtypes;
  const hasActiveFilters =
    !!search ||
    !sameDefaultSubtypes ||
    !sameDefaultActiveStatuses ||
    connectionStatuses.length > 0 ||
    priorities.length > 0 ||
    owners.length > 0;

  // ─── Saved views ─────────────────────────────────────────────────
  type FundersView = {
    search: string;
    subtypes: string[];
    activeStatuses: string[];
    connectionStatuses: string[];
    priorities: string[];
    owners: string[];
    sort: SortState;
    columns: ColumnsState | null;
  };
  const currentView: FundersView = {
    search,
    subtypes,
    activeStatuses,
    connectionStatuses,
    priorities,
    owners,
    sort: ts.sort,
    columns: columnsState,
  };
  const clearAll = () => {
    setSearch("");
    setSubtypes(DEFAULT_SUBTYPES);
    setActiveStatuses(DEFAULT_ACTIVE_STATUSES);
    setConnectionStatuses([]);
    setPriorities([]);
    setOwners([]);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
    selection.clear();
  };
  const viewsCtrl = useSavedViews<FundersView>({
    listKey: "funding-entities",
    current: currentView,
    apply: (s) => {
      setSearch(s.search ?? "");
      setSubtypes(s.subtypes ?? DEFAULT_SUBTYPES);
      setActiveStatuses(s.activeStatuses ?? DEFAULT_ACTIVE_STATUSES);
      setConnectionStatuses(s.connectionStatuses ?? []);
      setPriorities(s.priorities ?? []);
      setOwners(s.owners ?? []);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      setColumnsState(s.columns ?? null);
      setPage(1);
      selection.clear();
    },
    isDefault: (s) => {
      const sortedSubtypes = [...(s.subtypes ?? [])].sort().join(",");
      const sortedActiveStatuses = [...(s.activeStatuses ?? [])].sort().join(",");
      return (
        !s.search &&
        sortedSubtypes === sortedDefaultSubtypes &&
        sortedActiveStatuses === sortedDefaultActiveStatuses &&
        (s.connectionStatuses?.length ?? 0) === 0 &&
        (s.priorities?.length ?? 0) === 0 &&
        (s.owners?.length ?? 0) === 0 &&
        (s.sort?.key ?? null) === null &&
        (s.columns ?? null) === null
      );
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Funders
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
          </p>
        </div>
        <CreateFunderDialog />
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
            aria-label="Search funders by name"
            data-testid="input-search-funders"
          />
        </div>

        <MultiFilterSelect
          label="Subtype"
          selected={subtypes}
          onChange={(v) => { setSubtypes(v); setPage(1); selection.clear(); }}
          options={SUBTYPES}
          testId="select-subtype"
          includeBlank
        />
        <MultiFilterSelect
          label="Active status"
          selected={activeStatuses}
          onChange={(v) => { setActiveStatuses(v); setPage(1); selection.clear(); }}
          options={ACTIVE_STATUSES}
          testId="select-active-status"
          includeBlank
        />
        <MultiFilterSelect
          label="Connection"
          selected={connectionStatuses}
          onChange={(v) => { setConnectionStatuses(v); setPage(1); selection.clear(); }}
          options={CONNECTION_STATUSES}
          testId="select-connection-status"
          includeBlank
        />
        <MultiFilterSelect
          label="Priority"
          selected={priorities}
          onChange={(v) => { setPriorities(v); setPage(1); selection.clear(); }}
          options={PRIORITIES}
          testId="select-priority"
          includeBlank
        />
        <OwnerMultiFilter
          selected={owners}
          onChange={(v) => { setOwners(v); setPage(1); selection.clear(); }}
          testId="select-funder-owner"
        />

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setSubtypes(DEFAULT_SUBTYPES);
              setActiveStatuses(DEFAULT_ACTIVE_STATUSES);
              setConnectionStatuses([]);
              setPriorities([]);
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

      <div className="rounded-md border bg-card overflow-hidden">
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
                  aria-label="Select all funders on this page"
                  data-testid="checkbox-select-all-funders"
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
                  {error instanceof Error ? error.message : "Failed to load funders."}
                </TableCell>
              </TableRow>
            ) : pagedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">
                  No funders match these filters.
                </TableCell>
              </TableRow>
            ) : (
              pagedRows.map((f) => (
                <TableRow
                  key={f.id}
                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                  data-testid={`row-funder-${f.id}`}
                >
                  <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.isSelected(f.id)}
                      onCheckedChange={() => selection.toggle(f.id)}
                      aria-label={`Select ${f.name}`}
                      data-testid={`checkbox-select-${f.id}`}
                    />
                  </TableCell>
                  {visibleCols.map((c) => (
                    <TableCell key={c.key} className={c.tdClassName}>
                      {c.cell(f)}
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
        entityNoun="funder"
      />
      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        entityNoun="funder"
        selectedIds={selection.selectedIds}
        fields={FUNDERS_BULK_FIELDS}
        invalidateKeys={[getListFundersQueryKey()]}
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
              <PaginationPrevious
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setPage((p) => Math.max(1, p - 1));
                }}
                aria-disabled={page <= 1}
                className={
                  page <= 1 ? "pointer-events-none opacity-50" : undefined
                }
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
                className={
                  page >= totalPages
                    ? "pointer-events-none opacity-50"
                    : undefined
                }
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
