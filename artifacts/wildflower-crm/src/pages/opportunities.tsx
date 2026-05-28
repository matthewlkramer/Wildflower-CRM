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
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SavedViewsBar } from "@/components/saved-views-bar";
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
  const [page, setPage] = usePersistedState<number>(`${persistNs}.page`, 1);
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

  const params: ListOpportunitiesAndPledgesParams = {
    limit: PAGE_SIZE,
    page,
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

  const isPledgeView = pledgeView === "pledges";

  // Determine "is anything filtered beyond default?" for the Clear button.
  const sameDefaultStatus =
    statuses.length === defaultStatusArr.length &&
    [...statuses].sort().join(",") === [...defaultStatusArr].sort().join(",");
  const hasActiveFilters =
    !!search ||
    !sameDefaultStatus ||
    stages.length > 0 ||
    types.length > 0 ||
    fiscalYears.length > 0 ||
    owners.length > 0;

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
    sort: SortState;
  };
  const savedViewsListKey = `opportunities:${pledgeView ?? "all"}`;
  const currentView: OppsView = {
    search,
    statuses,
    stages,
    types,
    fiscalYears,
    owners,
    sort: ts.sort,
  };
  const clearAll = () => {
    setSearch("");
    setStatuses(defaultStatusArr);
    setStages([]);
    setTypes([]);
    setFiscalYears([]);
    setOwners([]);
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
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
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
        (s.sort?.key ?? null) === null
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
        canSave={hasActiveFilters || ts.sort.key !== null}
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
        <MultiFilterSelect
          label="Status"
          selected={statuses}
          onChange={(v) => { setStatuses(v); setPage(1); selection.clear(); }}
          options={STATUSES}
          testId="select-opp-status"
        />
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
              setStatuses(defaultStatusArr);
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
              {isPledgeView && (
                <SortableTH colKey="paid" align="right" {...ts}>Paid</SortableTH>
              )}
              <SortableTH colKey="entities" sortable={false} {...ts}>Entities</SortableTH>
              {!isPledgeView && (
                <SortableTH colKey="fy" {...ts}>FY</SortableTH>
              )}
              {!isPledgeView && (
                <SortableTH colKey="projectedClose" {...ts}>Projected close</SortableTH>
              )}
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
                      {o.status ? <Badge variant={o.status === "cash_in" || o.status === "pledge" ? "default" : "outline"}>{formatEnum(o.status)}</Badge> : "—"}
                    </TableCell>
                    {isPledgeView ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {coveredFys.length === 0 ? "—" : coveredFys.join(", ")}
                      </TableCell>
                    ) : (
                      <TableCell className="text-right tabular-nums">{formatCurrency(o.askAmount)}</TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{formatCurrency(o.awardedAmount)}</TableCell>
                    {isPledgeView && (
                      <TableCell className="text-right tabular-nums">{formatCurrency(o.paidAmount)}</TableCell>
                    )}
                    <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                      {entities.length === 0 ? "—" : entities.join(", ")}
                    </TableCell>
                    {!isPledgeView && (
                      <TableCell className="text-xs text-muted-foreground">
                        {coveredFys.length === 0 ? "—" : coveredFys.join(", ")}
                      </TableCell>
                    )}
                    {!isPledgeView && (
                      <TableCell>{formatDateShort(o.projectedCloseDate)}</TableCell>
                    )}
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

