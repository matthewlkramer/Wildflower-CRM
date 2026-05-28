import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useBulkUpdateGiftsAndPayments,
  type ListGiftsAndPaymentsParams,
  type GiftType,
  useListEntities,
  getListEntitiesQueryKey,
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SavedViewsBar } from "@/components/saved-views-bar";
import type { SortState } from "@/lib/table-helpers";
import { useEntityFilter } from "@/lib/entity-filter-context";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { GIFTS_BULK_FIELDS } from "@/lib/bulk-fields";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { FiscalYearMultiSelect } from "@/components/fiscal-year-multi-select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { DonorCell } from "@/components/donor-cell";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";

const TYPES: GiftType[] = [
  "standard_gift",
  "pledge_payment",
  "directed_gift",
  "loan_fund_investment",
  "matching_gift",
];

const PAGE_SIZE = 50;
const COL_SPAN = 10;

export default function Gifts() {
  // Filter state is persisted per-tab so back-navigation from a gift
  // detail page restores the same filtered/paginated view.
  const [search, setSearch] = usePersistedState<string>("wf.list.gifts.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [types, setTypes] = usePersistedState<string[]>("wf.list.gifts.types", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.gifts.owners", []);
  const [fiscalYears, setFiscalYears] = usePersistedState<string[]>("wf.list.gifts.fiscalYears", []);
  const [page, setPage] = usePersistedState<number>("wf.list.gifts.page", 1);
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkMut = useBulkUpdateGiftsAndPayments();

  // Global entity filter (header dropdown). Forwarded to the server so the
  // gifts list is scoped to gifts with at least one allocation on the
  // selected entities. Mirrors the dashboard and opportunities pages.
  const { selected: globalEntityIds } = useEntityFilter();

  const ts = useTableState("gifts");
  const sortActive = ts.sort.key !== null;
  const params: ListGiftsAndPaymentsParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(types.length > 0 ? { type: [...types].sort() as GiftType[] } : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(fiscalYears.length > 0 ? { fiscalYear: [...fiscalYears].sort() } : {}),
    ...(globalEntityIds.length > 0
      ? { entityId: [...globalEntityIds].sort() }
      : {}),
  };

  const { data, isLoading, isError, error } = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });

  const userNames = useUserNameMap();
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const entityNameById = new Map<string, string>(
    (entitiesQ.data ?? []).map((e) => [e.id, e.name]),
  );

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => (r.name ?? "").toLowerCase(),
          donor: (r) =>
            (r.funderName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
          dateReceived: (r) => r.dateReceived ?? null,
          type: (r) => r.type ?? null,
          amount: (r) => (r.amount != null ? Number(r.amount) : null),
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

  // ─── Saved views ─────────────────────────────────────────────────
  type GiftsView = {
    search: string;
    types: string[];
    owners: string[];
    fiscalYears: string[];
    sort: SortState;
  };
  const currentView: GiftsView = { search, types, owners, fiscalYears, sort: ts.sort };
  const clearAll = () => {
    setSearch("");
    setTypes([]);
    setOwners([]);
    setFiscalYears([]);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
    selection.clear();
  };
  const viewsCtrl = useSavedViews<GiftsView>({
    listKey: "gifts",
    current: currentView,
    apply: (s) => {
      setSearch(s.search ?? "");
      setTypes(s.types ?? []);
      setOwners(s.owners ?? []);
      setFiscalYears(s.fiscalYears ?? []);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      setPage(1);
      selection.clear();
    },
    isDefault: (s) =>
      !s.search &&
      (s.types?.length ?? 0) === 0 &&
      (s.owners?.length ?? 0) === 0 &&
      (s.fiscalYears?.length ?? 0) === 0 &&
      (s.sort?.key ?? null) === null,
  });
  const hasActiveFilters =
    !!search || types.length > 0 || owners.length > 0 || fiscalYears.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Gifts & payments</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
        </p>
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
            onChange={(e) => { setSearch(e.target.value); setPage(1); selection.clear(); }}
            aria-label="Search gifts by name"
            data-testid="input-search-gifts"
          />
        </div>
        <MultiFilterSelect
          label="Type"
          selected={types}
          onChange={(v) => { setTypes(v); setPage(1); selection.clear(); }}
          options={TYPES}
          testId="select-gift-type"
          includeBlank
        />
        <OwnerMultiFilter
          selected={owners}
          onChange={(v) => { setOwners(v); setPage(1); selection.clear(); }}
          testId="select-gift-owner"
        />
        <FiscalYearMultiSelect
          selected={fiscalYears}
          onChange={(v) => { setFiscalYears(v); setPage(1); selection.clear(); }}
          testId="select-gift-fiscal-year"
        />
        {(search || types.length > 0 || owners.length > 0 || fiscalYears.length > 0) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setTypes([]);
              setOwners([]);
              setFiscalYears([]);
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
                    pagedRows.length > 0 &&
                    pagedRows.every((r) => selection.isSelected(r.id))
                  }
                  onCheckedChange={() => selection.toggleVisible(pagedRows.map((r) => r.id))}
                  aria-label="Select all gifts on this page"
                  data-testid="checkbox-select-all-gifts"
                />
              </TableHead>
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="donor" {...ts}>Donor</SortableTH>
              <SortableTH colKey="dateReceived" {...ts}>Date received</SortableTH>
              <SortableTH colKey="type" {...ts}>Type</SortableTH>
              <SortableTH colKey="amount" align="right" {...ts}>Amount</SortableTH>
              <SortableTH colKey="entities" sortable={false} {...ts}>Entities</SortableTH>
              <SortableTH colKey="usages" sortable={false} {...ts}>Usages</SortableTH>
              <SortableTH colKey="grantYears" sortable={false} {...ts}>Grant years</SortableTH>
              <SortableTH colKey="owner" {...ts}>Owner</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={COL_SPAN} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load gifts."}
                </TableCell>
              </TableRow>
            ) : pagedRows.length === 0 ? (
              <TableRow><TableCell colSpan={COL_SPAN} className="text-center h-24 text-muted-foreground">No gifts match these filters.</TableCell></TableRow>
            ) : (
              pagedRows.map((g) => {
                const entities = (g.entityIds ?? []).map(
                  (id) => entityNameById.get(id) ?? id,
                );
                const usages = g.displayUsages ?? [];
                const grantYears = (g.grantYears ?? []).map((y) => y.toUpperCase());
                return (
                  <TableRow key={g.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-gift-${g.id}`}>
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selection.isSelected(g.id)}
                        onCheckedChange={() => selection.toggle(g.id)}
                        aria-label={`Select ${g.name ?? g.id}`}
                        data-testid={`checkbox-select-${g.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/gifts/${g.id}`} className="block w-full">{g.name ?? `Gift ${g.id}`}</Link>
                    </TableCell>
                    <TableCell>
                      <DonorCell
                        funderId={g.funderId}
                        funderName={g.funderName}
                        funderPriority={g.funderPriority}
                        householdId={g.householdId}
                        householdName={g.householdName}
                        individualGiverPersonId={g.individualGiverPersonId}
                        individualGiverPersonName={g.individualGiverPersonName}
                        individualGiverPersonPriority={g.individualGiverPersonPriority}
                      />
                    </TableCell>
                    <TableCell>{formatDateShort(g.dateReceived)}</TableCell>
                    <TableCell>{formatEnum(g.type)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(g.amount)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                      {entities.length === 0 ? "—" : entities.join(", ")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[240px]">
                      {usages.length === 0 ? "—" : usages.join("; ")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {grantYears.length === 0 ? "—" : grantYears.join(", ")}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {g.ownerUserId
                        ? (userNames.get(g.ownerUserId) ?? g.ownerUserId)
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
        entityNoun="gift"
      />
      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        entityNoun="gift"
        selectedIds={selection.selectedIds}
        fields={GIFTS_BULK_FIELDS}
        invalidateKeys={[getListGiftsAndPaymentsQueryKey()]}
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
