import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueries } from "@tanstack/react-query";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOrganizations,
  getListOrganizationsQueryKey,
  useBulkUpdateOrganizations,
  useMergeOrganizations,
  useGetCurrentUser,
  getGetOrganizationQueryOptions,
  getGetOrganizationQueryKey,
  type ListOrganizationsParams,
  type Organization,
  type ConnectionStatus,
  type ActiveStatus,
  type CapacityRating,
  type Priority,
} from "@workspace/api-client-react";
import { MergeDialog, type MergeField, type MergeRecord } from "@/components/merge-dialog";
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
import { BulkActionBar } from "@/components/bulk-action-bar";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { ORGANIZATIONS_BULK_FIELDS } from "@/lib/bulk-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCapacity, formatCurrency, formatDateShort, formatEnum, formatEnthusiasm, formatOrganizationNameShort } from "@/lib/format";
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
import { CreateOrganizationDialog } from "@/components/create-funder-dialog";
import { PriorityStar } from "@/components/priority-star";
import { PriorityTooltip } from "@/components/priority-tooltip";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { RegionMultiFilter } from "@/components/region-multi-filter";
import { useUserNameMap } from "@/components/user-picker";
import { canSeeIdentity, displayOrganizationName, ANONYMOUS_LABEL, type Viewer } from "@/lib/visibility";
import { useRegionNameMap } from "@/components/region-picker";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

const SUBTYPES: string[] = [
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
const DEFAULT_EXCLUDED_SUBTYPES: string[] = [
  "nonprofit",
  "education_forprofit",
  "corporation",
  "daf_platform",
  "platform",
  "capital_provider",
];
const DEFAULT_SUBTYPES: string[] = SUBTYPES.filter(
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

const CAPACITY_TIERS: CapacityRating[] = [
  "tier_1k_10k",
  "tier_10k_50k",
  "tier_50k_250k",
  "tier_250k_1m",
  "tier_1m_plus",
];
const ENTHUSIASM_OPTIONS = [
  { value: "7-advocate", label: "7-Advocate" },
  { value: "6-supportive", label: "6-Supportive" },
  { value: "5-warm", label: "5-Warm" },
  { value: "4-neutral", label: "4-Neutral" },
  { value: "3-cool", label: "3-Cool" },
  { value: "2-unsupportive", label: "2-Unsupportive" },
  { value: "1-hostile", label: "1-Hostile" },
] as const;
const STRATEGIC_ALIGNMENTS = ["high", "medium", "low"] as const;

const PAGE_SIZE = 50;
const PRIORITY_LABEL: Record<string, string> = { top: "Top", high: "High", medium: "Medium", low: "Low" };

type ColCtx = {
  userNames: Map<string, string>;
  regionNames: Map<string, string>;
  viewer: Viewer;
};

function buildColumns(ctx: ColCtx): ColumnDef<Organization>[] {
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
        <Link href={`/organizations/${f.id}`} className="block w-full">
          {canSeeIdentity(f, ctx.viewer) ? formatOrganizationNameShort(f.name) : ANONYMOUS_LABEL}
        </Link>
      ),
    },
    {
      key: "priorityTier",
      label: "Priority tier",
      header: (
        <span className="inline-flex items-center gap-1">
          Priority tier
          <PriorityTooltip />
        </span>
      ),
      cell: (f) =>
        f.priority ? (
          <Badge variant="outline">{PRIORITY_LABEL[f.priority] ?? f.priority}</Badge>
        ) : (
          "—"
        ),
    },
    {
      key: "entityType",
      label: "Type",
      cell: (f) => formatEnum(f.entityType),
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
      cell: (f) => formatEnthusiasm(f.enthusiasm),
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
    {
      key: "lastContacted",
      label: "Last contacted",
      defaultVisible: false,
      cell: (f) => formatDateShort(f.lastContacted),
    },
    {
      key: "interestsAges",
      label: "Ages",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (f) => {
        const vals = f.interestsAges ?? [];
        return vals.length === 0 ? "—" : vals.join(", ");
      },
    },
    {
      key: "interestsThematic",
      label: "Themes",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (f) => {
        const vals = f.interestsThematic ?? [];
        return vals.length === 0 ? "—" : vals.join(", ");
      },
    },
    {
      key: "interestsGovModels",
      label: "Governance",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (f) => {
        const vals = f.interestsGovModels ?? [];
        return vals.length === 0 ? "—" : vals.join(", ");
      },
    },
    {
      key: "regionIds",
      label: "Regions",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[200px]",
      cell: (f) => {
        const ids = f.regionIds ?? [];
        if (ids.length === 0) return "—";
        return ids.map((id) => ctx.regionNames.get(id) ?? id).join(", ");
      },
    },
  ];
}

export default function Organizations() {
  // Filter state persists per-tab so back-navigation from a funder
  // detail restores the same filtered view.
  const [search, setSearch] = usePersistedState<string>("wf.list.funders.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [issuesGrants, setIssuesGrants] = usePersistedState<boolean | undefined>("wf.list.funders.issuesGrants", undefined);
  const [subtypes, setSubtypes] = usePersistedState<string[]>("wf.list.funders.subtypes", DEFAULT_SUBTYPES);
  const [activeStatuses, setActiveStatuses] = usePersistedState<string[]>("wf.list.funders.activeStatuses", DEFAULT_ACTIVE_STATUSES);
  const [connectionStatuses, setConnectionStatuses] = usePersistedState<string[]>("wf.list.funders.connectionStatuses", []);
  const [priorities, setPriorities] = usePersistedState<string[]>("wf.list.funders.priorities", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.funders.owners", []);
  const [lifetimeGivingPresence, setLifetimeGivingPresence] = usePersistedState<PresenceValue>("wf.list.funders.f.lifetimeGiving", undefined);
  const [openAsksPresence, setOpenAsksPresence] = usePersistedState<PresenceValue>("wf.list.funders.f.openAsks", undefined);
  const [primaryContactPresence, setPrimaryContactPresence] = usePersistedState<PresenceValue>("wf.list.funders.f.primaryContact", undefined);
  const [capacityTiers, setCapacityTiers] = usePersistedState<string[]>("wf.list.funders.capacity", []);
  const [enthusiasms, setEnthusiasms] = usePersistedState<string[]>("wf.list.funders.enthusiasms", []);
  const [strategicAlignments, setStrategicAlignments] = usePersistedState<string[]>("wf.list.funders.strategicAlignments", []);
  const [regionIdsSel, setRegionIdsSel] = usePersistedState<string[]>("wf.list.funders.regionIds", []);
  const [page, setPage] = usePersistedState<number>("wf.list.funders.page", 1);
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    "wf.list.funders.columns",
    null,
  );
  const [filtersState, setFiltersState] = usePersistedState<FiltersState | null>(
    "wf.list.funders.filters",
    null,
  );
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkMut = useBulkUpdateOrganizations();
  const [mergeOpen, setMergeOpen] = useState(false);
  const mergeMut = useMergeOrganizations();

  const ts = useTableState("funding-entities");
  const sortActive = ts.sort.key !== null;
  const params: ListOrganizationsParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(issuesGrants !== undefined ? { issuesGrants } : {}),
    ...(subtypes.length > 0 ? { entityType: [...subtypes].sort() } : {}),
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
    ...(lifetimeGivingPresence ? { lifetimeGivingPresence } : {}),
    ...(openAsksPresence ? { openAsksPresence } : {}),
    ...(primaryContactPresence ? { primaryContactPresence } : {}),
    ...(capacityTiers.length > 0 ? { capacityRating: [...capacityTiers].sort() as CapacityRating[] } : {}),
    ...(enthusiasms.length > 0 ? { enthusiasm: [...enthusiasms].sort() } : {}),
    ...(strategicAlignments.length > 0 ? { strategicAlignment: [...strategicAlignments].sort() } : {}),
    ...(regionIdsSel.length > 0 ? { regionIds: [...regionIdsSel].sort() } : {}),
  };

  const { data, isLoading, isError, error } = useListOrganizations(params, {
    query: { queryKey: getListOrganizationsQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const userNames = useUserNameMap();
  const regionNames = useRegionNameMap();

  // Fetch full records for the merge dialog only while it's open.
  const mergeSelected = mergeOpen ? selection.selectedIds : [];
  const mergeQueries = useQueries({
    queries: mergeSelected.map((id) =>
      getGetOrganizationQueryOptions(id, {
        query: {
          enabled: mergeOpen,
          staleTime: 30_000,
          queryKey: getGetOrganizationQueryKey(id),
        },
      }),
    ),
  });
  const mergeRecords = useMemo<MergeRecord[]>(
    () =>
      mergeQueries
        .map((q) => q.data)
        .filter((d): d is Organization => !!d)
        .map((d) => d as unknown as MergeRecord),
    [mergeQueries],
  );
  const mergeLoading = mergeOpen && mergeQueries.some((q) => q.isLoading);

  const mergeFields = useMemo<MergeField[]>(
    () => [
      { key: "name", label: "Name" },
      { key: "entityType", label: "Type", display: (v) => formatEnum(v as string | null) },
      { key: "capacityRating", label: "Capacity", display: (v) => formatCapacity(v as string | null) },
      { key: "activeStatus", label: "Active status", display: (v) => formatEnum(v as string | null) },
      { key: "connectionStatus", label: "Connection", display: (v) => formatEnum(v as string | null) },
      { key: "enthusiasm", label: "Enthusiasm", display: (v) => formatEnthusiasm(v as string | null) },
      { key: "strategicAlignment", label: "Strategic alignment", display: (v) => formatEnum(v as string | null) },
      { key: "priority", label: "Priority", display: (v) => formatEnum(v as string | null) },
      {
        key: "ownerUserId",
        label: "Owner",
        display: (v) => (v ? (userNames.get(v as string) ?? String(v)) : "—"),
      },
      { key: "lastContacted", label: "Last contacted", display: (v) => formatDateShort(v as string | null) },
      { key: "website", label: "Website" },
      { key: "orgEmail", label: "Org email" },
      { key: "emailDomain", label: "Email domain" },
      { key: "linkedin", label: "LinkedIn" },
    ],
    [userNames],
  );

  const mergeLabel = (r: MergeRecord): string => {
    const f = r as unknown as Organization;
    return (f.name as string | null) || f.id;
  };

  const viewer = useGetCurrentUser().data ?? null;
  const registry = useMemo(() => buildColumns({ userNames, regionNames, viewer }), [userNames, regionNames, viewer]);
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 1;

  const sortedDefaultActiveStatuses = [...DEFAULT_ACTIVE_STATUSES].sort().join(",");
  const sameDefaultActiveStatuses =
    [...activeStatuses].sort().join(",") === sortedDefaultActiveStatuses;
  const sortedDefaultSubtypes = [...DEFAULT_SUBTYPES].sort().join(",");
  const sameDefaultSubtypes =
    [...subtypes].sort().join(",") === sortedDefaultSubtypes;

  // Filter registry — enum filters default visible; presence filters on
  // computed columns are opt-in (defaultVisible:false). Each def's
  // `clear` resets its value so hiding an active filter stops narrowing.
  const filterRegistry = useMemo<FilterDef[]>(
    () => [
      {
        key: "issuesGrants",
        label: "Grant-making",
        active: issuesGrants !== undefined,
        clear: () => { setIssuesGrants(undefined); setPage(1); selection.clear(); },
        render: () => (
          <select
            className="h-8 rounded border px-2 text-sm bg-background"
            value={issuesGrants === undefined ? "" : String(issuesGrants)}
            onChange={(e) => {
              const v = e.target.value;
              setIssuesGrants(v === "" ? undefined : v === "true");
              setPage(1);
              selection.clear();
            }}
            data-testid="select-issues-grants"
          >
            <option value="">All organizations</option>
            <option value="true">Grant-making only</option>
            <option value="false">Non-grant-making only</option>
          </select>
        ),
      },
      {
        key: "entityType",
        label: "Type",
        active: !sameDefaultSubtypes,
        clear: () => { setSubtypes(DEFAULT_SUBTYPES); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Subtype"
            selected={subtypes}
            onChange={(v) => { setSubtypes(v); setPage(1); selection.clear(); }}
            options={SUBTYPES}
            testId="select-subtype"
            includeBlank
          />
        ),
      },
      {
        key: "activeStatus",
        label: "Active status",
        active: !sameDefaultActiveStatuses,
        clear: () => { setActiveStatuses(DEFAULT_ACTIVE_STATUSES); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Active status"
            selected={activeStatuses}
            onChange={(v) => { setActiveStatuses(v); setPage(1); selection.clear(); }}
            options={ACTIVE_STATUSES}
            testId="select-active-status"
            includeBlank
          />
        ),
      },
      {
        key: "connection",
        label: "Connection",
        active: connectionStatuses.length > 0,
        clear: () => { setConnectionStatuses([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Connection"
            selected={connectionStatuses}
            onChange={(v) => { setConnectionStatuses(v); setPage(1); selection.clear(); }}
            options={CONNECTION_STATUSES}
            testId="select-connection-status"
            includeBlank
          />
        ),
      },
      {
        key: "priority",
        label: "Priority",
        active: priorities.length > 0,
        clear: () => { setPriorities([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Priority"
            selected={priorities}
            onChange={(v) => { setPriorities(v); setPage(1); selection.clear(); }}
            options={PRIORITIES}
            testId="select-priority"
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
            testId="select-funder-owner"
          />
        ),
      },
      {
        key: "lifetimeGiving",
        label: "Lifetime giving",
        defaultVisible: false,
        active: !!lifetimeGivingPresence,
        clear: () => { setLifetimeGivingPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Lifetime giving"
            value={lifetimeGivingPresence}
            onChange={(v) => { setLifetimeGivingPresence(v); setPage(1); selection.clear(); }}
            testId="filter-lifetime-giving"
          />
        ),
      },
      {
        key: "openAsks",
        label: "Open asks",
        defaultVisible: false,
        active: !!openAsksPresence,
        clear: () => { setOpenAsksPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Open asks"
            value={openAsksPresence}
            onChange={(v) => { setOpenAsksPresence(v); setPage(1); selection.clear(); }}
            testId="filter-open-asks"
          />
        ),
      },
      {
        key: "primaryContact",
        label: "Primary contact",
        defaultVisible: false,
        active: !!primaryContactPresence,
        clear: () => { setPrimaryContactPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Primary contact"
            value={primaryContactPresence}
            onChange={(v) => { setPrimaryContactPresence(v); setPage(1); selection.clear(); }}
            testId="filter-primary-contact"
          />
        ),
      },
      {
        key: "capacity",
        label: "Capacity",
        defaultVisible: false,
        active: capacityTiers.length > 0,
        clear: () => { setCapacityTiers([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Capacity"
            selected={capacityTiers}
            onChange={(v) => { setCapacityTiers(v); setPage(1); selection.clear(); }}
            options={CAPACITY_TIERS}
            testId="select-funder-capacity"
            includeBlank
          />
        ),
      },
      {
        key: "enthusiasm",
        label: "Enthusiasm",
        defaultVisible: false,
        active: enthusiasms.length > 0,
        clear: () => { setEnthusiasms([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Enthusiasm"
            selected={enthusiasms}
            onChange={(v) => { setEnthusiasms(v); setPage(1); selection.clear(); }}
            options={[...ENTHUSIASM_OPTIONS]}
            testId="select-funder-enthusiasm"
            includeBlank
          />
        ),
      },
      {
        key: "strategicAlignment",
        label: "Strategic alignment",
        defaultVisible: false,
        active: strategicAlignments.length > 0,
        clear: () => { setStrategicAlignments([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Strategic alignment"
            selected={strategicAlignments}
            onChange={(v) => { setStrategicAlignments(v); setPage(1); selection.clear(); }}
            options={[...STRATEGIC_ALIGNMENTS]}
            testId="select-funder-strategic-alignment"
            includeBlank
          />
        ),
      },
      {
        key: "region",
        label: "Region",
        defaultVisible: false,
        active: regionIdsSel.length > 0,
        clear: () => { setRegionIdsSel([]); setPage(1); selection.clear(); },
        render: () => (
          <RegionMultiFilter
            selected={regionIdsSel}
            onChange={(v) => { setRegionIdsSel(v); setPage(1); selection.clear(); }}
            testId="select-funder-region"
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [issuesGrants, subtypes, activeStatuses, connectionStatuses, priorities, owners, lifetimeGivingPresence, openAsksPresence, primaryContactPresence, sameDefaultSubtypes, sameDefaultActiveStatuses, capacityTiers, enthusiasms, strategicAlignments, regionIdsSel],
  );
  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
  );

  const CAPACITY_ORDER: Record<string, number> = {
    tier_1k_10k: 0, tier_10k_50k: 1, tier_50k_250k: 2, tier_250k_1m: 3, tier_1m_plus: 4,
  };
  const PRIORITY_ORDER: Record<string, number> = { top: 4, high: 3, medium: 2, low: 1 };
  const ALIGNMENT_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          priority: (r) => (r.priority === "top" ? 1 : 0),
          name: (r) => displayOrganizationName(r, viewer).toLowerCase(),
          entityType: (r) => r.entityType ?? null,
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
          lastContacted: (r) => r.lastContacted ?? null,
          owner: (r) =>
            r.ownerUserId
              ? (userNames.get(r.ownerUserId) ?? r.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [rows, ts.sort, userNames, regionNames, viewer],
  );
  const pagedRows = useMemo(() => {
    if (!sortActive) return sortedRows;
    const maxPage = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), maxPage);
    return sortedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [sortActive, sortedRows, page]);

  const hasActiveFilters =
    !!search ||
    issuesGrants !== undefined ||
    !sameDefaultSubtypes ||
    !sameDefaultActiveStatuses ||
    connectionStatuses.length > 0 ||
    priorities.length > 0 ||
    owners.length > 0 ||
    !!lifetimeGivingPresence ||
    !!openAsksPresence ||
    !!primaryContactPresence ||
    capacityTiers.length > 0 ||
    enthusiasms.length > 0 ||
    strategicAlignments.length > 0 ||
    regionIdsSel.length > 0;

  // ─── Saved views ─────────────────────────────────────────────────
  type FundersView = {
    search: string;
    issuesGrants: boolean | undefined;
    subtypes: string[];
    activeStatuses: string[];
    connectionStatuses: string[];
    priorities: string[];
    owners: string[];
    lifetimeGivingPresence: PresenceValue;
    openAsksPresence: PresenceValue;
    primaryContactPresence: PresenceValue;
    capacityTiers: string[];
    enthusiasms: string[];
    strategicAlignments: string[];
    regionIdsSel: string[];
    sort: SortState;
    columns: ColumnsState | null;
    filters: FiltersState | null;
  };
  const currentView: FundersView = {
    search,
    issuesGrants,
    subtypes,
    activeStatuses,
    connectionStatuses,
    priorities,
    owners,
    lifetimeGivingPresence,
    openAsksPresence,
    primaryContactPresence,
    capacityTiers,
    enthusiasms,
    strategicAlignments,
    regionIdsSel,
    sort: ts.sort,
    columns: columnsState,
    filters: filtersState,
  };
  const clearAll = () => {
    setSearch("");
    setIssuesGrants(undefined);
    setSubtypes(DEFAULT_SUBTYPES);
    setActiveStatuses(DEFAULT_ACTIVE_STATUSES);
    setConnectionStatuses([]);
    setPriorities([]);
    setOwners([]);
    setLifetimeGivingPresence(undefined);
    setOpenAsksPresence(undefined);
    setPrimaryContactPresence(undefined);
    setCapacityTiers([]);
    setEnthusiasms([]);
    setStrategicAlignments([]);
    setRegionIdsSel([]);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
    selection.clear();
  };
  const viewsCtrl = useSavedViews<FundersView>({
    listKey: "funding-entities",
    current: currentView,
    apply: (s) => {
      setSearch(s.search ?? "");
      setIssuesGrants(s.issuesGrants ?? undefined);
      setSubtypes(s.subtypes ?? DEFAULT_SUBTYPES);
      setActiveStatuses(s.activeStatuses ?? DEFAULT_ACTIVE_STATUSES);
      setConnectionStatuses(s.connectionStatuses ?? []);
      setPriorities(s.priorities ?? []);
      setOwners(s.owners ?? []);
      setLifetimeGivingPresence(s.lifetimeGivingPresence ?? undefined);
      setOpenAsksPresence(s.openAsksPresence ?? undefined);
      setPrimaryContactPresence(s.primaryContactPresence ?? undefined);
      setCapacityTiers(s.capacityTiers ?? []);
      setEnthusiasms(s.enthusiasms ?? []);
      setStrategicAlignments(s.strategicAlignments ?? []);
      setRegionIdsSel(s.regionIdsSel ?? []);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      setColumnsState(s.columns ?? null);
      setFiltersState(s.filters ?? null);
      setPage(1);
      selection.clear();
    },
    isDefault: (s) => {
      const sortedSubtypes = [...(s.subtypes ?? [])].sort().join(",");
      const sortedActiveStatuses = [...(s.activeStatuses ?? [])].sort().join(",");
      return (
        !s.search &&
        s.issuesGrants === undefined &&
        sortedSubtypes === sortedDefaultSubtypes &&
        sortedActiveStatuses === sortedDefaultActiveStatuses &&
        (s.connectionStatuses?.length ?? 0) === 0 &&
        (s.priorities?.length ?? 0) === 0 &&
        (s.owners?.length ?? 0) === 0 &&
        !s.lifetimeGivingPresence &&
        !s.openAsksPresence &&
        !s.primaryContactPresence &&
        (s.capacityTiers?.length ?? 0) === 0 &&
        (s.enthusiasms?.length ?? 0) === 0 &&
        (s.strategicAlignments?.length ?? 0) === 0 &&
        (s.regionIdsSel?.length ?? 0) === 0 &&
        (s.sort?.key ?? null) === null &&
        (s.columns ?? null) === null &&
        (s.filters ?? null) === null
      );
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Organizations
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
          </p>
        </div>
        <CreateOrganizationDialog />
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
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
              selection.clear();
            }}
            aria-label="Search funders by name"
            data-testid="input-search-funders"
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
              setSubtypes(DEFAULT_SUBTYPES);
              setActiveStatuses(DEFAULT_ACTIVE_STATUSES);
              setConnectionStatuses([]);
              setPriorities([]);
              setOwners([]);
              setLifetimeGivingPresence(undefined);
              setOpenAsksPresence(undefined);
              setPrimaryContactPresence(undefined);
              setCapacityTiers([]);
              setEnthusiasms([]);
              setStrategicAlignments([]);
              setRegionIdsSel([]);
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
                  data-testid={`row-organization-${f.id}`}
                >
                  <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selection.isSelected(f.id)}
                      onCheckedChange={() => selection.toggle(f.id)}
                      aria-label={`Select ${displayOrganizationName(f, viewer)}`}
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
        onMerge={() => setMergeOpen(true)}
        onClear={selection.clear}
        entityNoun="organization"
      />
      {mergeOpen && !mergeLoading && mergeRecords.length >= 2 && (
        <MergeDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          entityNoun="organization"
          records={mergeRecords}
          fields={mergeFields}
          recordLabel={mergeLabel}
          invalidateKeys={[getListOrganizationsQueryKey()]}
          onSubmit={async ({ primaryId, mergeIds, overrides }) =>
            mergeMut.mutateAsync({ data: { primaryId, mergeIds, overrides } })
          }
          onDone={() => selection.clear()}
        />
      )}
      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        entityNoun="organization"
        selectedIds={selection.selectedIds}
        fields={ORGANIZATIONS_BULK_FIELDS}
        invalidateKeys={[getListOrganizationsQueryKey()]}
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
