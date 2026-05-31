import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useBulkUpdateGiftsAndPayments,
  type ListGiftsAndPaymentsParams,
  type GiftType,
  type GiftPaymentMethod,
  type GiftOrPayment,
  useListEntities,
  getListEntitiesQueryKey,
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SavedViewsBar } from "@/components/saved-views-bar";
import { ColumnsMenu } from "@/components/columns-menu";
import { FiltersMenu } from "@/components/filters-menu";
import { resolveColumns, type ColumnDef, type ColumnsState } from "@/lib/columns";
import { resolveFilters, type FilterDef, type FiltersState } from "@/lib/filters";
import { PresenceFilter, type PresenceValue } from "@/components/presence-filter";
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
const PAYMENT_METHODS: GiftPaymentMethod[] = [
  "ach",
  "check",
  "wire",
  "stock",
  "donor_box",
  "daf_ach",
  "daf_check",
  "daf_bill_com",
];

const PAGE_SIZE = 50;

type ColCtx = {
  userNames: Map<string, string>;
  entityNameById: Map<string, string>;
};

function buildColumns(ctx: ColCtx): ColumnDef<GiftOrPayment>[] {
  return [
    {
      key: "name",
      label: "Name",
      required: true,
      tdClassName: "font-medium",
      cell: (g) => (
        <Link href={`/gifts/${g.id}`} className="block w-full">
          {g.name ?? `Gift ${g.id}`}
        </Link>
      ),
    },
    {
      key: "donor",
      label: "Donor",
      cell: (g) => (
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
      ),
    },
    {
      key: "dateReceived",
      label: "Date received",
      cell: (g) => formatDateShort(g.dateReceived),
    },
    {
      key: "type",
      label: "Type",
      cell: (g) => formatEnum(g.type),
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (g) => formatCurrency(g.amount),
    },
    {
      key: "entities",
      label: "Entities",
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (g) => {
        const entities = (g.entityIds ?? []).map(
          (id) => ctx.entityNameById.get(id) ?? id,
        );
        return entities.length === 0 ? "—" : entities.join(", ");
      },
    },
    {
      key: "usages",
      label: "Usages",
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[240px]",
      cell: (g) => {
        const usages = g.displayUsages ?? [];
        return usages.length === 0 ? "—" : usages.join("; ");
      },
    },
    {
      key: "grantYears",
      label: "Grant years",
      sortable: false,
      tdClassName: "text-xs text-muted-foreground",
      cell: (g) => {
        const grantYears = (g.grantYears ?? []).map((y) => y.toUpperCase());
        return grantYears.length === 0 ? "—" : grantYears.join(", ");
      },
    },
    {
      key: "owner",
      label: "Owner",
      tdClassName: "text-sm text-muted-foreground",
      cell: (g) =>
        g.ownerUserId ? (ctx.userNames.get(g.ownerUserId) ?? g.ownerUserId) : "—",
    },
    {
      key: "paymentMethod",
      label: "Payment method",
      defaultVisible: false,
      cell: (g) => formatEnum(g.paymentMethod),
    },
    {
      key: "thankYouSentAt",
      label: "Thank-you sent",
      defaultVisible: false,
      cell: (g) => formatDateShort(g.thankYouSentAt),
    },
  ];
}

export default function Gifts() {
  // Filter state is persisted per-tab so back-navigation from a gift
  // detail page restores the same filtered/paginated view.
  const [search, setSearch] = usePersistedState<string>("wf.list.gifts.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [types, setTypes] = usePersistedState<string[]>("wf.list.gifts.types", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.gifts.owners", []);
  const [fiscalYears, setFiscalYears] = usePersistedState<string[]>("wf.list.gifts.fiscalYears", []);
  const [entitiesPresence, setEntitiesPresence] = usePersistedState<PresenceValue>("wf.list.gifts.f.entities", undefined);
  const [usagesPresence, setUsagesPresence] = usePersistedState<PresenceValue>("wf.list.gifts.f.usages", undefined);
  const [grantYearsPresence, setGrantYearsPresence] = usePersistedState<PresenceValue>("wf.list.gifts.f.grantYears", undefined);
  const [paymentMethods, setPaymentMethods] = usePersistedState<string[]>("wf.list.gifts.paymentMethods", []);
  const [thankYouPresence, setThankYouPresence] = usePersistedState<PresenceValue>("wf.list.gifts.f.thankYouSentAt", undefined);
  const [page, setPage] = usePersistedState<number>("wf.list.gifts.page", 1);
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    "wf.list.gifts.columns",
    null,
  );
  const [filtersState, setFiltersState] = usePersistedState<FiltersState | null>(
    "wf.list.gifts.filters",
    null,
  );
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
    ...(entitiesPresence ? { entitiesPresence } : {}),
    ...(usagesPresence ? { usagesPresence } : {}),
    ...(grantYearsPresence ? { grantYearsPresence } : {}),
    ...(paymentMethods.length > 0 ? { paymentMethod: [...paymentMethods].sort() as GiftPaymentMethod[] } : {}),
    ...(thankYouPresence ? { thankYouSentAtPresence: thankYouPresence } : {}),
  };

  const { data, isLoading, isError, error } = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });

  const userNames = useUserNameMap();
  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const entityNameById = useMemo(
    () => new Map<string, string>((entitiesQ.data ?? []).map((e) => [e.id, e.name])),
    [entitiesQ.data],
  );

  const registry = useMemo(
    () => buildColumns({ userNames, entityNameById }),
    [userNames, entityNameById],
  );
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 1;

  // Filter registry — enum filters default visible; presence filters on
  // computed columns are opt-in (defaultVisible:false). Each def's
  // `clear` resets its value so hiding an active filter stops narrowing.
  const filterRegistry = useMemo<FilterDef[]>(
    () => [
      {
        key: "type",
        label: "Type",
        active: types.length > 0,
        clear: () => { setTypes([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Type"
            selected={types}
            onChange={(v) => { setTypes(v); setPage(1); selection.clear(); }}
            options={TYPES}
            testId="select-gift-type"
            includeBlank
          />
        ),
      },
      {
        key: "owner",
        label: "Owner",
        active: owners.length > 0,
        clear: () => { setOwners([]); setPage(1); selection.clear(); },
        render: () => (
          <OwnerMultiFilter
            selected={owners}
            onChange={(v) => { setOwners(v); setPage(1); selection.clear(); }}
            testId="select-gift-owner"
          />
        ),
      },
      {
        key: "fiscalYear",
        label: "Fiscal year",
        active: fiscalYears.length > 0,
        clear: () => { setFiscalYears([]); setPage(1); selection.clear(); },
        render: () => (
          <FiscalYearMultiSelect
            selected={fiscalYears}
            onChange={(v) => { setFiscalYears(v); setPage(1); selection.clear(); }}
            testId="select-gift-fiscal-year"
          />
        ),
      },
      {
        key: "entities",
        label: "Entities",
        defaultVisible: false,
        active: !!entitiesPresence,
        clear: () => { setEntitiesPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Entities"
            value={entitiesPresence}
            onChange={(v) => { setEntitiesPresence(v); setPage(1); selection.clear(); }}
            testId="filter-entities"
          />
        ),
      },
      {
        key: "usages",
        label: "Usages",
        defaultVisible: false,
        active: !!usagesPresence,
        clear: () => { setUsagesPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Usages"
            value={usagesPresence}
            onChange={(v) => { setUsagesPresence(v); setPage(1); selection.clear(); }}
            testId="filter-usages"
          />
        ),
      },
      {
        key: "grantYears",
        label: "Grant years",
        defaultVisible: false,
        active: !!grantYearsPresence,
        clear: () => { setGrantYearsPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Grant years"
            value={grantYearsPresence}
            onChange={(v) => { setGrantYearsPresence(v); setPage(1); selection.clear(); }}
            testId="filter-grant-years"
          />
        ),
      },
      {
        key: "paymentMethod",
        label: "Payment method",
        defaultVisible: false,
        active: paymentMethods.length > 0,
        clear: () => { setPaymentMethods([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Payment method"
            selected={paymentMethods}
            onChange={(v) => { setPaymentMethods(v); setPage(1); selection.clear(); }}
            options={PAYMENT_METHODS}
            testId="select-payment-method"
            includeBlank
          />
        ),
      },
      {
        key: "thankYouSentAt",
        label: "Thank-you sent",
        defaultVisible: false,
        active: !!thankYouPresence,
        clear: () => { setThankYouPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Thank-you sent"
            value={thankYouPresence}
            onChange={(v) => { setThankYouPresence(v); setPage(1); selection.clear(); }}
            testId="filter-thank-you-sent"
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [types, owners, fiscalYears, entitiesPresence, usagesPresence, grantYearsPresence, paymentMethods, thankYouPresence],
  );
  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
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
          paymentMethod: (r) => r.paymentMethod ?? null,
          thankYouSentAt: (r) => r.thankYouSentAt ?? null,
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
    entitiesPresence: PresenceValue;
    usagesPresence: PresenceValue;
    grantYearsPresence: PresenceValue;
    paymentMethods: string[];
    thankYouPresence: PresenceValue;
    sort: SortState;
    columns: ColumnsState | null;
    filters: FiltersState | null;
  };
  const currentView: GiftsView = {
    search,
    types,
    owners,
    fiscalYears,
    entitiesPresence,
    usagesPresence,
    grantYearsPresence,
    paymentMethods,
    thankYouPresence,
    sort: ts.sort,
    columns: columnsState,
    filters: filtersState,
  };
  const clearAll = () => {
    setSearch("");
    setTypes([]);
    setOwners([]);
    setFiscalYears([]);
    setEntitiesPresence(undefined);
    setUsagesPresence(undefined);
    setGrantYearsPresence(undefined);
    setPaymentMethods([]);
    setThankYouPresence(undefined);
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
      setEntitiesPresence(s.entitiesPresence ?? undefined);
      setUsagesPresence(s.usagesPresence ?? undefined);
      setGrantYearsPresence(s.grantYearsPresence ?? undefined);
      setPaymentMethods(s.paymentMethods ?? []);
      setThankYouPresence(s.thankYouPresence ?? undefined);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      setColumnsState(s.columns ?? null);
      setFiltersState(s.filters ?? null);
      setPage(1);
      selection.clear();
    },
    isDefault: (s) =>
      !s.search &&
      (s.types?.length ?? 0) === 0 &&
      (s.owners?.length ?? 0) === 0 &&
      (s.fiscalYears?.length ?? 0) === 0 &&
      !s.entitiesPresence &&
      !s.usagesPresence &&
      !s.grantYearsPresence &&
      (s.paymentMethods?.length ?? 0) === 0 &&
      !s.thankYouPresence &&
      (s.sort?.key ?? null) === null &&
      (s.columns ?? null) === null &&
      (s.filters ?? null) === null,
  });
  const hasActiveFilters =
    !!search ||
    types.length > 0 ||
    owners.length > 0 ||
    fiscalYears.length > 0 ||
    !!entitiesPresence ||
    !!usagesPresence ||
    !!grantYearsPresence ||
    paymentMethods.length > 0 ||
    !!thankYouPresence;

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
        canSave={hasActiveFilters || ts.sort.key !== null || columnsState !== null || filtersState !== null}
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
        {visibleFilters.map((f) => (
          <div key={f.key}>{f.render()}</div>
        ))}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setTypes([]);
              setOwners([]);
              setFiscalYears([]);
              setEntitiesPresence(undefined);
              setUsagesPresence(undefined);
              setGrantYearsPresence(undefined);
              setPaymentMethods([]);
              setThankYouPresence(undefined);
              setPage(1);
              selection.clear();
            }}
          >
            Clear
          </Button>
        )}

        <div className="ml-auto flex items-end gap-2">
          <FiltersMenu
            registry={filterRegistry}
            state={filtersState}
            onChange={setFiltersState}
          />
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
                  aria-label="Select all gifts on this page"
                  data-testid="checkbox-select-all-gifts"
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
              <TableRow><TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load gifts."}
                </TableCell>
              </TableRow>
            ) : pagedRows.length === 0 ? (
              <TableRow><TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">No gifts match these filters.</TableCell></TableRow>
            ) : (
              pagedRows.map((g) => (
                <TableRow key={g.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-gift-${g.id}`}>
                  <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.isSelected(g.id)}
                      onCheckedChange={() => selection.toggle(g.id)}
                      aria-label={`Select ${g.name ?? g.id}`}
                      data-testid={`checkbox-select-${g.id}`}
                    />
                  </TableCell>
                  {visibleCols.map((c) => (
                    <TableCell key={c.key} className={c.tdClassName}>
                      {c.cell(g)}
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
