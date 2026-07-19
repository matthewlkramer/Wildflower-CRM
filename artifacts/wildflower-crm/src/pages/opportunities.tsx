import { useCallback, useMemo, useState, Fragment } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient, useQueries } from "@tanstack/react-query";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useBulkUpdateOpportunitiesAndPledges,
  useBulkArchiveOpportunitiesAndPledges,
  useArchiveOpportunityOrPledge,
  useUnarchiveOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  getGetOpportunityOrPledgeQueryOptions,
  getGetOpportunityOrPledgeQueryKey,
  useListEntities,
  ListOpportunitiesAndPledgesWorklist,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityStatus,
  type OpportunityStage,
  type OpportunityType,
  type OpportunityOrPledge,
  type OpportunityOrPledgeDetail,
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
import { BulkArchiveDialog } from "@/components/bulk-archive-dialog";
import { OPPORTUNITIES_BULK_FIELDS } from "@/lib/bulk-fields";
import {
  RowActionIcons,
  InlineRowSaveActions,
} from "@/components/row-action-icons";
import { ShowArchivedToggle } from "@/components/show-archived-toggle";
import { ListPageHeader } from "@/components/list-page-header";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useInlineRowEdit } from "@/hooks/use-inline-row-edit";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { PageJumper } from "@/components/page-jumper";
import { DonorCell } from "@/components/donor-cell";
import { CreateOpportunityDialog } from "@/components/create-opportunity-dialog";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { FiscalYearMultiSelect } from "@/components/fiscal-year-multi-select";
import { useUserNameMap } from "@/components/user-picker";
import { LayoutList, Columns3, X, ChevronDown, ChevronRight } from "lucide-react";
import { OpportunityKanban } from "@/components/opportunity-kanban";

const KANBAN_LIMIT = 500;
const STATUSES: OpportunityStatus[] = ["open", "pledge", "cash_in", "dormant", "lost"];
// `pledge` is stored as-is but surfaced to fundraisers as "Waiting for payment".
const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  pledge: "Waiting for payment",
  cash_in: "Cash in",
  dormant: "Dormant",
  lost: "Lost",
};
const STAGES: OpportunityStage[] = [
  "cold_lead",
  "warm_lead",
  "in_conversation",
  "convince",
  "probable_renewal",
  "verbal_confirmation",
  "complete",
];
const TYPES: OpportunityType[] = ["solicitation", "renewal", "open_application"];

const PAGE_SIZE = 50;

// Human labels for the donor-lifecycle worklist banner.
const OPP_WORKLIST_LABELS: Record<ListOpportunitiesAndPledgesWorklist, string> = {
  verbal_no_letter: "Verbal yes, no letter",
  committed_unpaid: "Committed but unpaid",
  partially_paid: "Partially paid pledges",
};

const NONE = "__none__";
type OppDraft = {
  type: string;
};

type InlineCtx = {
  editingId: string | null;
  draft: OppDraft | null;
  isEditing: (id: string) => boolean;
  patch: (partial: Partial<OppDraft>) => void;
  save: () => void;
  cancel: () => void;
  saving: boolean;
};

type ColCtx = {
  isPledgeView: boolean;
  basePath: string;
  userNames: Map<string, string>;
  entityNameById: Map<string, string>;
  isAdmin: boolean;
  inline: InlineCtx;
  onOpen: (o: OpportunityOrPledge) => void;
  onStartEdit: (o: OpportunityOrPledge) => void;
  onArchive: (o: OpportunityOrPledge) => void;
  onUnarchive: (o: OpportunityOrPledge) => void;
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
          organizationId={o.organizationId}
          organizationName={o.organizationName}
          organizationPriority={o.organizationPriority}
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
            {STATUS_LABEL[o.status] ?? formatEnum(o.status)}
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
    {
      key: "type",
      label: "Type",
      defaultVisible: false,
      cell: (o) =>
        ctx.inline.isEditing(o.id) ? (
          <Select
            value={ctx.inline.draft?.type ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ type: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Type"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-type-opp-${o.id}`}
            >
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {formatEnum(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          formatEnum(o.type)
        ),
    },
    {
      key: "applicationDeadline",
      label: "App deadline",
      defaultVisible: false,
      cell: (o) => formatDateShort(o.applicationDeadline),
    },
    {
      key: "winProbability",
      label: "Win prob.",
      defaultVisible: false,
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (o) =>
        o.winProbability != null ? `${Math.round(Number(o.winProbability) * 100)}%` : "—",
    },
    {
      key: "actions",
      label: "",
      required: true,
      alwaysLast: true,
      sortable: false,
      align: "right",
      thClassName: "w-32",
      tdClassName: "text-right",
      cell: (o) =>
        ctx.inline.isEditing(o.id) ? (
          <InlineRowSaveActions
            onSave={ctx.inline.save}
            onCancel={ctx.inline.cancel}
            saving={ctx.inline.saving}
            testIdPrefix={`opp-${o.id}`}
          />
        ) : (
          <RowActionIcons
            entityLabel={o.name ?? `Untitled ${o.id}`}
            testIdPrefix={`opp-${o.id}`}
            disabled={ctx.inline.editingId !== null}
            archived={!!o.archivedAt}
            onOpen={() => ctx.onOpen(o)}
            onEdit={() => ctx.onStartEdit(o)}
            onArchive={
              o.archivedAt
                ? ctx.isAdmin
                  ? () => ctx.onUnarchive(o)
                  : undefined
                : () => ctx.onArchive(o)
            }
          />
        ),
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
  const [projectedCloseDatePresence, setProjectedCloseDatePresence] = usePersistedState<PresenceValue>(`${persistNs}.f.projectedClose`, undefined);
  const [applicationDeadlinePresence, setApplicationDeadlinePresence] = usePersistedState<PresenceValue>(`${persistNs}.f.appDeadline`, undefined);
  const [winProbabilityPresence, setWinProbabilityPresence] = usePersistedState<PresenceValue>(`${persistNs}.f.winProb`, undefined);
  const [expandedOppIds, setExpandedOppIds] = useState<Set<string>>(new Set());
  const [page, setPage] = usePersistedState<number>(`${persistNs}.page`, 1);
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    `${persistNs}.columns`,
    null,
  );
  const [filtersState, setFiltersState] = usePersistedState<FiltersState | null>(
    `${persistNs}.filters`,
    null,
  );
  // Opportunities default to the Kanban board on first visit; pledges and the
  // unscoped view default to the list. Existing saved preferences are respected.
  const defaultViewMode: "list" | "kanban" = pledgeView === "opportunities" ? "kanban" : "list";
  const [viewMode, setViewMode] = usePersistedState<"list" | "kanban">(`${persistNs}.view`, defaultViewMode);
  // Pledges never offer Kanban — force the effective view to the list so a
  // previously-persisted Kanban preference can't surface it there.
  const effectiveViewMode: "list" | "kanban" = pledgeView === "pledges" ? "list" : viewMode;
  const selection = useRowSelection();
  const [, navigate] = useLocation();
  // Donor-lifecycle worklist preset, read from the URL (?worklist=...). Set by
  // the dashboard worklist tiles. Only the values valid for this list endpoint
  // are honored; anything else is ignored. URL-driven only (not a saved-view
  // filter) — a dismissible banner shows when active.
  const urlSearch = useSearch();
  const rawWorklist = new URLSearchParams(urlSearch).get("worklist");
  const worklist: ListOpportunitiesAndPledgesWorklist | undefined =
    rawWorklist &&
    (Object.values(ListOpportunitiesAndPledgesWorklist) as string[]).includes(rawWorklist)
      ? (rawWorklist as ListOpportunitiesAndPledgesWorklist)
      : undefined;
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = usePersistedState<boolean>(
    `${persistNs}.showArchived`,
    false,
  );
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const bulkMut = useBulkUpdateOpportunitiesAndPledges();
  const bulkArchiveMut = useBulkArchiveOpportunitiesAndPledges();
  const archiveMut = useArchiveOpportunityOrPledge();
  const unarchiveMut = useUnarchiveOpportunityOrPledge();
  const updateOpp = useUpdateOpportunityOrPledge();
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
    limit: effectiveViewMode === "kanban" ? KANBAN_LIMIT : (sortActive ? 10000 : PAGE_SIZE),
    page: effectiveViewMode === "kanban" ? 1 : (sortActive ? 1 : page),
    ...(isAdmin && showArchived ? { includeArchived: true } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(pledgeView ? { pledgeView } : {}),
    ...(worklist ? { worklist } : {}),
    ...(effectiveStatuses.length > 0
      ? { status: effectiveStatuses as OpportunityStatus[] }
      : {}),
    // Pledges intentionally have no stage/type filter — never let stale
    // persisted state or a saved view silently narrow the pledges query.
    // In kanban view the board already groups by stage, so a stage filter
    // would just narrow the columns — never apply it there.
    ...(pledgeView !== "pledges" && effectiveViewMode !== "kanban" && stages.length > 0
      ? { stage: [...stages].sort() as OpportunityStage[] }
      : {}),
    ...(pledgeView !== "pledges" && types.length > 0
      ? { type: [...types].sort() as OpportunityType[] }
      : {}),
    ...(fiscalYears.length > 0 ? { fiscalYear: [...fiscalYears].sort() } : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(globalEntityIds.length > 0
      ? { entityId: [...globalEntityIds].sort() }
      : {}),
    ...(paidPresence ? { paidPresence } : {}),
    ...(coveredFysPresence ? { coveredFysPresence } : {}),
    ...(entitiesPresence ? { entitiesPresence } : {}),
    ...(projectedCloseDatePresence ? { projectedCloseDatePresence } : {}),
    ...(applicationDeadlinePresence ? { applicationDeadlinePresence } : {}),
    ...(winProbabilityPresence ? { winProbabilityPresence } : {}),
  };

  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(params, {
    query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const isPledgeView = pledgeView === "pledges";
  const userNames = useUserNameMap();

  const refreshList = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: getListOpportunitiesAndPledgesQueryKey(),
      }),
    [queryClient],
  );

  const inlineEdit = useInlineRowEdit<OpportunityOrPledge, OppDraft>({
    getId: (o) => o.id,
    toDraft: (o) => ({ type: o.type ?? NONE }),
    onSave: async (id, d) => {
      await updateOpp.mutateAsync({
        id,
        data: { type: d.type === NONE ? null : (d.type as OpportunityType) },
      });
      await refreshList();
      toast({ title: "Opportunity updated" });
    },
  });

  const archiveOpp = (o: OpportunityOrPledge) =>
    archiveMut.mutate(
      { id: o.id },
      {
        onSuccess: async () => {
          await refreshList();
          selection.removeMany([o.id]);
          toast({ title: "Opportunity archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const unarchiveOpp = (o: OpportunityOrPledge) =>
    unarchiveMut.mutate(
      { id: o.id },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Opportunity unarchived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Unarchive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const registry = useMemo(
    () => {
      const cols = buildColumns({
        isPledgeView,
        basePath,
        userNames,
        entityNameById,
        isAdmin,
        inline: {
          editingId: inlineEdit.editingId,
          draft: inlineEdit.draft,
          isEditing: inlineEdit.isEditing,
          patch: inlineEdit.patch,
          save: () => {
            void inlineEdit.save();
          },
          cancel: inlineEdit.cancel,
          saving: inlineEdit.saving,
        },
        onOpen: (o) => navigate(`${basePath}/${o.id}`),
        onStartEdit: (o) => inlineEdit.start(o),
        onArchive: archiveOpp,
        onUnarchive: unarchiveOpp,
      });
      // Pledges hide the Stage column (stage is irrelevant once committed).
      return isPledgeView ? cols.filter((c) => c.key !== "stage") : cols;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPledgeView, basePath, userNames, entityNameById, isAdmin, inlineEdit, navigate],
  );
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 1 + (isPledgeView ? 1 : 0);

  // Expand/collapse: for pledges only, fetch the detail to show allocation sub-rows.
  const toggleExpandOpp = (id: string) =>
    setExpandedOppIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const expandOppQueries = useQueries({
    queries: isPledgeView
      ? [...expandedOppIds].map((id) =>
          getGetOpportunityOrPledgeQueryOptions(id, {
            query: { enabled: true, staleTime: 60_000, queryKey: getGetOpportunityOrPledgeQueryKey(id) },
          }),
        )
      : [],
  });
  const expandedOppDetailsById = useMemo(() => {
    const map = new Map<string, OpportunityOrPledgeDetail>();
    for (const q of expandOppQueries) {
      if (q.data) map.set(q.data.id, q.data);
    }
    return map;
  }, [expandOppQueries]);

  // Determine "is anything filtered beyond default?" for the Clear button.
  const sameDefaultStatus =
    statuses.length === defaultStatusArr.length &&
    [...statuses].sort().join(",") === [...defaultStatusArr].sort().join(",");

  // Filter registry — enum filters default visible; presence filters on
  // computed columns are opt-in (defaultVisible:false). Each def's
  // `clear` resets its value so hiding an active filter stops narrowing.
  const filterRegistry = useMemo<FilterDef[]>(
    () => {
      const defs: FilterDef[] = [
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
            options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] ?? formatEnum(s) }))}
            testId="select-opp-status"
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
      {
        key: "projectedCloseDate",
        label: "Projected close",
        defaultVisible: false,
        active: !!projectedCloseDatePresence,
        clear: () => { setProjectedCloseDatePresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Projected close"
            value={projectedCloseDatePresence}
            onChange={(v) => { setProjectedCloseDatePresence(v); setPage(1); selection.clear(); }}
            testId="filter-projected-close"
          />
        ),
      },
      {
        key: "applicationDeadline",
        label: "App deadline",
        defaultVisible: false,
        active: !!applicationDeadlinePresence,
        clear: () => { setApplicationDeadlinePresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="App deadline"
            value={applicationDeadlinePresence}
            onChange={(v) => { setApplicationDeadlinePresence(v); setPage(1); selection.clear(); }}
            testId="filter-app-deadline"
          />
        ),
      },
      {
        key: "winProbability",
        label: "Win probability",
        defaultVisible: false,
        active: !!winProbabilityPresence,
        clear: () => { setWinProbabilityPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Win probability"
            value={winProbabilityPresence}
            onChange={(v) => { setWinProbabilityPresence(v); setPage(1); selection.clear(); }}
            testId="filter-win-probability"
          />
        ),
      },
      ];
      // Pledges drop the stage filter (stage is irrelevant once committed) and
      // the type filter (solicitation/renewal/open_application is a funnel
      // attribute) — both belong to the opportunities funnel, not pledges.
      // Kanban view groups columns by stage, so the stage filter is redundant
      // there — hide it from both the chooser and the filter row.
      return defs.filter((d) => {
        if (isPledgeView && (d.key === "stage" || d.key === "type")) return false;
        if (effectiveViewMode === "kanban" && d.key === "stage") return false;
        return true;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statuses, stages, types, fiscalYears, owners, paidPresence, coveredFysPresence, entitiesPresence, projectedCloseDatePresence, applicationDeadlinePresence, winProbabilityPresence, sameDefaultStatus, defaultStatusArr, isPledgeView, effectiveViewMode],
  );
  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
  );

  const STAGE_ORDER: Record<string, number> = {
    cold_lead: 1, warm_lead: 2, in_conversation: 3, convince: 4,
    probable_renewal: 5, verbal_confirmation: 6, complete: 7,
    // deprecated stages retained so any not-yet-backfilled rows still sort sanely
    conditional_commitment: 6, written_commitment: 6, cash_in: 7,
  };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => (r.name ?? "").toLowerCase(),
          donor: (r) =>
            (r.organizationName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
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
          type: (r) => r.type ?? null,
          applicationDeadline: (r) => r.applicationDeadline ?? null,
          winProbability: (r) => (r.winProbability != null ? Number(r.winProbability) : null),
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
  const kanbanTruncated = effectiveViewMode === "kanban" && total > rows.length;
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
    (!isPledgeView && stages.length > 0) ||
    (!isPledgeView && types.length > 0) ||
    fiscalYears.length > 0 ||
    owners.length > 0 ||
    !!paidPresence ||
    !!coveredFysPresence ||
    !!entitiesPresence ||
    !!projectedCloseDatePresence ||
    !!applicationDeadlinePresence ||
    !!winProbabilityPresence;

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
    projectedCloseDatePresence: PresenceValue;
    applicationDeadlinePresence: PresenceValue;
    winProbabilityPresence: PresenceValue;
    sort: SortState;
    columns: ColumnsState | null;
    filters: FiltersState | null;
  };
  const savedViewsListKey = `opportunities:${pledgeView ?? "all"}`;
  const currentView: OppsView = {
    search,
    statuses,
    stages: isPledgeView ? [] : stages,
    types: isPledgeView ? [] : types,
    fiscalYears,
    owners,
    paidPresence,
    coveredFysPresence,
    entitiesPresence,
    projectedCloseDatePresence,
    applicationDeadlinePresence,
    winProbabilityPresence,
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
    setProjectedCloseDatePresence(undefined);
    setApplicationDeadlinePresence(undefined);
    setWinProbabilityPresence(undefined);
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
      setStages(isPledgeView ? [] : (s.stages ?? []));
      setTypes(isPledgeView ? [] : (s.types ?? []));
      setFiscalYears(s.fiscalYears ?? []);
      setOwners(s.owners ?? []);
      setPaidPresence(s.paidPresence ?? undefined);
      setCoveredFysPresence(s.coveredFysPresence ?? undefined);
      setEntitiesPresence(s.entitiesPresence ?? undefined);
      setProjectedCloseDatePresence(s.projectedCloseDatePresence ?? undefined);
      setApplicationDeadlinePresence(s.applicationDeadlinePresence ?? undefined);
      setWinProbabilityPresence(s.winProbabilityPresence ?? undefined);
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
        (isPledgeView || (s.stages?.length ?? 0) === 0) &&
        (isPledgeView || (s.types?.length ?? 0) === 0) &&
        (s.fiscalYears?.length ?? 0) === 0 &&
        (s.owners?.length ?? 0) === 0 &&
        !s.paidPresence &&
        !s.coveredFysPresence &&
        !s.entitiesPresence &&
        !s.projectedCloseDatePresence &&
        !s.applicationDeadlinePresence &&
        !s.winProbabilityPresence &&
        (s.sort?.key ?? null) === null &&
        (s.columns ?? null) === null &&
        (s.filters ?? null) === null
      );
    },
  });

  return (
    <div className="space-y-6">
      <ListPageHeader
        title={title}
        subtitle={isLoading ? <Skeleton className="h-4 w-20" /> : `${total.toLocaleString()} total`}
        addAction={
          <CreateOpportunityDialog mode={isPledgeView ? "pledge" : "opportunity"} />
        }
        controls={
          <>
            <ShowArchivedToggle
              value={showArchived}
              onChange={(v) => {
                setShowArchived(v);
                setPage(1);
                selection.clear();
              }}
              testId="toggle-show-archived-opportunities"
            />
            {!isPledgeView && (
              <div className="flex rounded-md border overflow-hidden">
                <Button
                  variant={effectiveViewMode === "list" ? "secondary" : "ghost"}
                  size="sm"
                  className="rounded-none border-0 px-2"
                  onClick={() => setViewMode("list")}
                  title="List view"
                  aria-label="Switch to list view"
                >
                  <LayoutList className="h-4 w-4" />
                </Button>
                <Button
                  variant={effectiveViewMode === "kanban" ? "secondary" : "ghost"}
                  size="sm"
                  className="rounded-none border-0 px-2"
                  onClick={() => setViewMode("kanban")}
                  title="Kanban view"
                  aria-label="Switch to kanban view"
                >
                  <Columns3 className="h-4 w-4" />
                </Button>
              </div>
            )}
            <FiltersMenu
              registry={filterRegistry}
              state={filtersState}
              onChange={setFiltersState}
            />
            {effectiveViewMode === "list" && (
              <ColumnsMenu
                registry={registry}
                state={columnsState}
                onChange={setColumnsState}
              />
            )}
          </>
        }
      />

      <SavedViewsBar
        controller={viewsCtrl}
        canSave={hasActiveFilters || ts.sort.key !== null || columnsState !== null || filtersState !== null}
        onClearAll={clearAll}
      />

      {worklist && (
        <div
          className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="worklist-banner"
        >
          <span>
            Showing worklist: <strong>{OPP_WORKLIST_LABELS[worklist]}</strong>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-amber-900 hover:bg-amber-100"
            onClick={() => navigate(pledgeView === "pledges" ? "/pledges" : "/opportunities")}
            data-testid="worklist-banner-clear"
          >
            Clear
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <div className="relative">
            <Input
              placeholder="Search by name…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); selection.clear(); }}
              aria-label="Search opportunities by name"
              data-testid="input-search-opportunities"
              className="pr-8"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="no-default-hover-elevate no-default-active-elevate absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => { setSearch(""); setPage(1); selection.clear(); }}
                aria-label="Clear search"
                data-testid="button-clear-search-opportunities"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
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
              setProjectedCloseDatePresence(undefined);
              setApplicationDeadlinePresence(undefined);
              setWinProbabilityPresence(undefined);
              setPage(1);
              selection.clear();
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {effectiveViewMode === "kanban" ? (
        <OpportunityKanban
          rows={rows}
          isLoading={isLoading}
          isError={isError}
          error={error}
          queryKey={getListOpportunitiesAndPledgesQueryKey(params)}
          truncated={kanbanTruncated}
        />
      ) : (
      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {isPledgeView && <TableHead className="w-6 px-1" />}
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
              <SkeletonRows cols={colSpan} />
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
                <Fragment key={o.id}>
                  <TableRow className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-opp-${o.id}`}>
                    {isPledgeView && (
                      <TableCell className="w-6 px-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 p-0 text-muted-foreground"
                          onClick={() => toggleExpandOpp(o.id)}
                          aria-label={expandedOppIds.has(o.id) ? "Collapse allocations" : "Expand allocations"}
                          tabIndex={-1}
                        >
                          {expandedOppIds.has(o.id)
                            ? <ChevronDown className="h-3 w-3" />
                            : <ChevronRight className="h-3 w-3" />
                          }
                        </Button>
                      </TableCell>
                    )}
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selection.isSelected(o.id)}
                        onCheckedChange={() => selection.toggle(o.id)}
                        aria-label={`Select ${o.name ?? o.id}`}
                        data-testid={`checkbox-select-${o.id}`}
                      />
                    </TableCell>
                    {visibleCols.map((c) => (
                      <TableCell
                        key={c.key}
                        className={c.tdClassName}
                        onClick={c.key !== "name" && c.key !== "actions" && !inlineEdit.isEditing(o.id) && !o.archivedAt ? () => inlineEdit.start(o) : undefined}
                        style={c.key !== "name" && c.key !== "actions" && !inlineEdit.isEditing(o.id) && !o.archivedAt ? { cursor: "text" } : undefined}
                      >
                        {c.cell(o)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {isPledgeView && expandedOppIds.has(o.id) && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell />
                      <TableCell colSpan={visibleCols.length} className="py-2">
                        {expandedOppDetailsById.has(o.id) ? (
                          (expandedOppDetailsById.get(o.id)!.allocations ?? []).length === 0 ? (
                            <span className="text-xs text-muted-foreground italic">No allocations</span>
                          ) : (
                            <table className="text-xs text-muted-foreground w-full">
                              <thead>
                                <tr className="text-left">
                                  <th className="font-medium pb-1 pr-3">Entity</th>
                                  <th className="font-medium pb-1 pr-3">FY</th>
                                  <th className="font-medium pb-1 pr-3 text-right">Awarded</th>
                                  <th className="font-medium pb-1">Usage</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(expandedOppDetailsById.get(o.id)!.allocations ?? []).map((a, i) => (
                                  <tr key={i}>
                                    <td className="pr-3 pb-0.5">{entityNameById.get(a.entityId ?? "") ?? "—"}</td>
                                    <td className="pr-3 pb-0.5">{a.grantYear?.toUpperCase() ?? "—"}</td>
                                    <td className="pr-3 pb-0.5 text-right tabular-nums">{a.subAmount != null ? `$${Number(a.subAmount).toLocaleString()}` : "—"}</td>
                                    <td className="pb-0.5">{a.intendedUsage != null ? a.intendedUsage.replace(/_/g, " ") : "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Loading…</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      )}

      {effectiveViewMode === "list" && (
        <BulkActionBar
          count={selection.count}
          onEdit={() => setBulkOpen(true)}
          onArchive={() => setBulkArchiveOpen(true)}
          onClear={selection.clear}
          entityNoun="opportunity"
        />
      )}
      <BulkArchiveDialog
        open={bulkArchiveOpen}
        onOpenChange={setBulkArchiveOpen}
        entityNoun="opportunity"
        selectedIds={selection.selectedIds}
        invalidateKeys={[getListOpportunitiesAndPledgesQueryKey()]}
        onConfirm={async () =>
          bulkArchiveMut.mutateAsync({ data: { ids: selection.selectedIds } })
        }
        onDone={(r) => selection.removeMany(r.succeededIds)}
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

      {effectiveViewMode === "list" && totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)); }} aria-disabled={page <= 1} className={page <= 1 ? "pointer-events-none opacity-50" : undefined} />
            </PaginationItem>
            <PaginationItem>
              <PageJumper
                page={page}
                totalPages={totalPages}
                onJump={setPage}
                className="mx-2"
              />
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
