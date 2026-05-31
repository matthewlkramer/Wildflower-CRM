import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useBulkUpdateOpportunitiesAndPledges,
  useListEntities,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityStatus,
  type OpportunityStage,
  type OpportunityType,
  type OpportunityOrPledge,
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
import { Checkbox } from "@/components/ui/checkbox";
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
import { FiscalYearMultiSelect } from "@/components/fiscal-year-multi-select";
import { useUserNameMap } from "@/components/user-picker";

const STATUSES: OpportunityStatus[] = ["open", "pledge", "cash_in", "dormant", "lost"];
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

type ColCtx = {
  isPledgeView: boolean;
  basePath: string;
  userNames: Map<string, string>;
  entityNameById: Map<string, string>;
};

// Single registry covers both pledge and opportunity views. The view
// toggle only flips `defaultVisible` on columns that conceptually belong
// to one side (Ask + Projected close lean toward opportunities; Paid
// leans toward pledges). Users can still surface any column on either
// view via the columns menu — the data fields exist on every row.
function buildColumns(ctx: ColCtx): ColumnDef<OpportunityOrPledge>[] {
  return [
    {
      key: "name",
      label: "Name",
      required: true,
      tdClassName: "font-medium",
      cell: (o) => (
        <Link href={`${ctx.basePath}/${o.id}`} className="block w-full">
          {o.name ?? `Untitled ${o.id}`}
        </Link>
      ),
    },
    {
      key: "donor",
      label: "Donor",
      cell: (o) => (
        <DonorCell
          funderId={o.funderId}
          funderName={o.funderName}
          funderPriority={o.funderPriority}
          householdId={o.householdId}
          householdName={o.householdName}
          individualGiverPersonId={o.individualGiverPersonId}
          individualGiverPersonName={o.individualGiverPersonName}
          individualGiverPersonPriority={o.individualGiverPersonPriority}
        />
      ),
    },
    {
      key: "stage",
      label: "Stage",
      cell: (o) => formatEnum(o.stage),
    },
    {
      key: "status",
      label: "Status",
      cell: (o) =>
        o.status ? (
          <Badge variant={o.status === "cash_in" || o.status === "pledge" ? "default" : "outline"}>
            {formatEnum(o.status)}
          </Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "ask",
      label: "Ask",
      align: "right",
      tdClassName: "text-right tabular-nums",
      defaultVisible: !ctx.isPledgeView,
      cell: (o) => formatCurrency(o.askAmount),
    },
    {
      key: "awarded",
      label: "Awarded",
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (o) => formatCurrency(o.awardedAmount),
    },
    {
      key: "paid",
      label: "Paid",
      align: "right",
      tdClassName: "text-right tabular-nums",
      defaultVisible: ctx.isPledgeView,
      cell: (o) => formatCurrency(o.paidAmount),
    },
    {
      key: "entities",
      label: "Entities",
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (o) => {
        const entities = (o.entityIds ?? []).map(
          (id) => ctx.entityNameById.get(id) ?? id,
        );
        return entities.length === 0 ? "—" : entities.join(", ");
      },
    },
    {
      key: "coveredFys",
      label: "Covered FYs",
      tdClassName: "text-xs text-muted-foreground",
      cell: (o) => {
        const coveredFys = (o.coveredFiscalYears ?? []).map((y) => y.toUpperCase());
        return coveredFys.length === 0 ? "—" : coveredFys.join(", ");
      },
    },
    {
      key: "projectedClose",
      label: "Projected close",
      defaultVisible: !ctx.isPledgeView,
      cell: (o) => formatDateShort(o.projectedCloseDate),
    },
    {
      key: "owner",
      label: "Owner",
      tdClassName: "text-sm text-muted-foreground",
      cell: (o) =>
        o.ownerUserId ? (ctx.userNames.get(o.ownerUserId) ?? o.ownerUserId) : "—",
    },
  ];
}

type Props = {
  title?: string;
  /**
   * Page split:
   *   "pledges"       → server applies (wasPledge=true OR stage ∈ pledge stages),
   *                     status filter defaults to all-but-cash_in.
   *   "opportunities" → server applies the complement,
   *                     status filter defaults to [open].
   * Omit for an unscoped view (admin / debugging).
   */
  pledgeView?: "pledges" | "opportunities";
  /** Default for the status filter when none is provided. */
  defaultStatuses?: OpportunityStatus[];
  basePath?: string;
};

export default function Opportunities({
  title = "Opportunities",
  pledgeView,
  defaultStatuses,
  basePath = "/opportunities",
}: Props) {
  // Filter state is persisted per-tab (sessionStorage) so navigating to
  // a detail row and clicking Back restores the same view. /opportunities
  // and /pledges (same component) need distinct namespaces so their
  // filters don't bleed into each other.
  const persistNs = `wf.list.opps.${pledgeView ?? "all"}`;
  const [search, setSearch] = usePersistedState<string>(`${persistNs}.search`, "");
  const debouncedSearch = useDebounce(search, 250);
  // All enum filters are multi-select. Status defaults to:
  //   pledges view       → [open, pledge] (active commitments; dormant + lost hidden)
  //   opportunities view → [open] only (active funnel)
  //   unscoped           → no default
  const defaultStatusArr: OpportunityStatus[] =
    defaultStatuses ??
    (pledgeView === "pledges"
      ? ["open", "pledge"]
      : pledgeView === "opportunities"
        ? ["open"]
        : []);
  const [statuses, setStatuses] = usePersistedState<string[]>(`${persistNs}.statuses`, defaultStatusArr);
  const [stages, setStages] = usePersistedState<string[]>(`${persistNs}.stages`, []);
  const [types, setTypes] = usePersistedState<string[]>(`${persistNs}.types`, []);
  const [fiscalYears, setFiscalYears] = usePersistedState<string[]>(`${persistNs}.fiscalYears`, []);
  const [owners, setOwners] = usePersistedState<string[]>(`${persistNs}.owners`, []);
  const [paidPresence, setPaidPresence] = usePersistedState<PresenceValue>(`${persistNs}.f.paid`, undefined);
  const [coveredFysPresence, setCoveredFysPresence] = usePersistedState<PresenceValue>(`${persistNs}.f.coveredFys`, undefined);
  const [entitiesPresence, setEntitiesPresence] = usePersistedState<PresenceValue>(`${persistNs}.f.entities`, undefined);
  const [page, setPage] = usePersistedState<number>(`${persistNs}.page`, 1);
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    `${persistNs}.columns`,
    null,
  );
  const [filtersState, setFiltersState] = usePersistedState<FiltersState | null>(
    `${persistNs}.filters`,
    null,
  );
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
  // Global entity filter (header dropdown). When the user has narrowed
  // to one or more entities we forward that into the list query so the
  // server only returns opps with at least one pledge_allocation on
  // those entities. Mirrors the dashboard behaviour.
  const { selected: globalEntityIds } = useEntityFilter();

  // Sort every array filter before serializing into request params so
  // the react-query cache key is stable regardless of the order the user
  // clicked checkboxes in (`['a','b']` and `['b','a']` would otherwise
  // produce distinct keys / refetches).
  const effectiveStatuses = [...statuses].sort();

  const ts = useTableState("opportunities");
  const sortActive = ts.sort.key !== null;
  const params: ListOpportunitiesAndPledgesParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(pledgeView ? { pledgeView } : {}),
    ...(effectiveStatuses.length > 0
      ? { status: effectiveStatuses as OpportunityStatus[] }
      : {}),
    ...(stages.length > 0 ? { stage: [...stages].sort() as OpportunityStage[] } : {}),
    ...(types.length > 0 ? { type: [...types].sort() as OpportunityType[] } : {}),
    ...(fiscalYears.length > 0 ? { fiscalYear: [...fiscalYears].sort() } : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(globalEntityIds.length > 0
      ? { entityId: [...globalEntityIds].sort() }
      : {}),
    ...(paidPresence ? { paidPresence } : {}),
    ...(coveredFysPresence ? { coveredFysPresence } : {}),
    ...(entitiesPresence ? { entitiesPresence } : {}),
  };

  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(params, {
    query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const isPledgeView = pledgeView === "pledges";
  const userNames = useUserNameMap();
  const registry = useMemo(
    () =>
      buildColumns({
        isPledgeView,
        basePath,
        userNames,
        entityNameById,
      }),
    [isPledgeView, basePath, userNames, entityNameById],
  );
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 1;

  // Determine "is anything filtered beyond default?" for the Clear button.
  const sameDefaultStatus =
    statuses.length === defaultStatusArr.length &&
    [...statuses].sort().join(",") === [...defaultStatusArr].sort().join(",");

  // Filter registry — enum filters default visible; presence filters on
  // computed columns are opt-in (defaultVisible:false). Each def's
  // `clear` resets its value so hiding an active filter stops narrowing.
  const filterRegistry = useMemo<FilterDef[]>(
    () => [
      {
        key: "status",
        label: "Status",
        active: !sameDefaultStatus,
        clear: () => { setStatuses(defaultStatusArr); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Status"
            selected={statuses}
            onChange={(v) => { setStatuses(v); setPage(1); selection.clear(); }}
            options={STATUSES}
            testId="select-opp-status"
            includeBlank
          />
        ),
      },
      {
        key: "stage",
        label: "Stage",
        active: stages.length > 0,
        clear: () => { setStages([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Stage"
            selected={stages}
            onChange={(v) => { setStages(v); setPage(1); selection.clear(); }}
            options={STAGES}
            testId="select-opp-stage"
            includeBlank
          />
        ),
      },
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
            testId="select-opp-type"
            includeBlank
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
            testId="select-opp-owner"
          />
        ),
      },
      {
        key: "paid",
        label: "Paid",
        defaultVisible: false,
        active: !!paidPresence,
        clear: () => { setPaidPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Paid"
            value={paidPresence}
            onChange={(v) => { setPaidPresence(v); setPage(1); selection.clear(); }}
            testId="filter-paid"
          />
        ),
      },
      {
        key: "coveredFys",
        label: "Covered FYs",
        defaultVisible: false,
        active: !!coveredFysPresence,
        clear: () => { setCoveredFysPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Covered FYs"
            value={coveredFysPresence}
            onChange={(v) => { setCoveredFysPresence(v); setPage(1); selection.clear(); }}
            testId="filter-covered-fys"
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
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statuses, stages, types, fiscalYears, owners, paidPresence, coveredFysPresence, entitiesPresence, sameDefaultStatus, defaultStatusArr],
  );
  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
  );

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
          paid: (r) => (r.paidAmount != null ? Number(r.paidAmount) : null),
          coveredFys: (r) => (r.coveredFiscalYears ?? []).join(",") || null,
          // Legacy alias: prior to the columns-config refactor the
          // non-pledge view's FY header sorted on `fy`. Keep the
          // accessor so users with that key persisted in localStorage
          // continue to get sorted rows after the upgrade.
          fy: (r) => (r.coveredFiscalYears ?? []).join(",") || null,
          awarded: (r) => (r.awardedAmount != null ? Number(r.awardedAmount) : null),
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
  const pagedRows = useMemo(() => {
    if (!sortActive) return sortedRows;
    const maxPage = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), maxPage);
    return sortedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [sortActive, sortedRows, page]);

  const hasActiveFilters =
    !!search ||
    !sameDefaultStatus ||
    stages.length > 0 ||
    types.length > 0 ||
    fiscalYears.length > 0 ||
    owners.length > 0 ||
    !!paidPresence ||
    !!coveredFysPresence ||
    !!entitiesPresence;

  // ─── Saved views ─────────────────────────────────────────────────
  // /opportunities and /pledges share this component but should not
  // share saved views — distinct listKey per pledgeView.
  type OppsView = {
    search: string;
    statuses: string[];
    stages: string[];
    types: string[];
    fiscalYears: string[];
    owners: string[];
    paidPresence: PresenceValue;
    coveredFysPresence: PresenceValue;
    entitiesPresence: PresenceValue;
    sort: SortState;
    columns: ColumnsState | null;
    filters: FiltersState | null;
  };
  const savedViewsListKey = `opportunities:${pledgeView ?? "all"}`;
  const currentView: OppsView = {
    search,
    statuses,
    stages,
    types,
    fiscalYears,
    owners,
    paidPresence,
    coveredFysPresence,
    entitiesPresence,
    sort: ts.sort,
    columns: columnsState,
    filters: filtersState,
  };
  const clearAll = () => {
    setSearch("");
    setStatuses(defaultStatusArr);
    setStages([]);
    setTypes([]);
    setFiscalYears([]);
    setOwners([]);
    setPaidPresence(undefined);
    setCoveredFysPresence(undefined);
    setEntitiesPresence(undefined);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
    selection.clear();
  };
  const viewsCtrl = useSavedViews<OppsView>({
    listKey: savedViewsListKey,
    current: currentView,
    apply: (s) => {
      setSearch(s.search ?? "");
      setStatuses(s.statuses ?? defaultStatusArr);
      setStages(s.stages ?? []);
      setTypes(s.types ?? []);
      setFiscalYears(s.fiscalYears ?? []);
      setOwners(s.owners ?? []);
      setPaidPresence(s.paidPresence ?? undefined);
      setCoveredFysPresence(s.coveredFysPresence ?? undefined);
      setEntitiesPresence(s.entitiesPresence ?? undefined);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      setColumnsState(s.columns ?? null);
      setFiltersState(s.filters ?? null);
      setPage(1);
      selection.clear();
    },
    isDefault: (s) => {
      const sortedStatuses = [...(s.statuses ?? [])].sort().join(",");
      const sortedDefaults = [...defaultStatusArr].sort().join(",");
      return (
        !s.search &&
        sortedStatuses === sortedDefaults &&
        (s.stages?.length ?? 0) === 0 &&
        (s.types?.length ?? 0) === 0 &&
        (s.fiscalYears?.length ?? 0) === 0 &&
        (s.owners?.length ?? 0) === 0 &&
        !s.paidPresence &&
        !s.coveredFysPresence &&
        !s.entitiesPresence &&
        (s.sort?.key ?? null) === null &&
        (s.columns ?? null) === null &&
        (s.filters ?? null) === null
      );
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">{title}</h1>
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
            aria-label="Search opportunities by name"
            data-testid="input-search-opportunities"
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
              setStatuses(defaultStatusArr);
              setStages([]);
              setTypes([]);
              setFiscalYears([]);
              setOwners([]);
              setPaidPresence(undefined);
              setCoveredFysPresence(undefined);
              setEntitiesPresence(undefined);
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
                  aria-label="Select all opportunities on this page"
                  data-testid="checkbox-select-all-opps"
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
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : pagedRows.length === 0 ? (
              <TableRow><TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">No opportunities match these filters.</TableCell></TableRow>
            ) : (
              pagedRows.map((o) => (
                <TableRow key={o.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-opp-${o.id}`}>
                  <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.isSelected(o.id)}
                      onCheckedChange={() => selection.toggle(o.id)}
                      aria-label={`Select ${o.name ?? o.id}`}
                      data-testid={`checkbox-select-${o.id}`}
                    />
                  </TableCell>
                  {visibleCols.map((c) => (
                    <TableCell key={c.key} className={c.tdClassName}>
                      {c.cell(o)}
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
