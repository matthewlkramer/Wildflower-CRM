import { useCallback, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOrganizations,
  getListOrganizationsQueryKey,
  useBulkUpdateOrganizations,
  useBulkArchiveOrganizations,
  useArchiveOrganization,
  useUnarchiveOrganization,
  useMergeOrganizations,
  useGetCurrentUser,
  getGetOrganizationQueryOptions,
  getGetOrganizationQueryKey,
  useUpdateOrganization,
  EntityType,
  type ListOrganizationsParams,
  type Organization,
  type ConnectionStatus,
  type Enthusiasm,
  type ActiveStatus,
  type CapacityRating,
  type Priority,
  type StrategicAlignment,
} from "@workspace/api-client-react";
import { LayoutList, Columns3, X } from "lucide-react";
import { EntityKanban, DraggableCard, type EntityKanbanPatch } from "@/components/entity-kanban";
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
import { BulkArchiveDialog } from "@/components/bulk-archive-dialog";
import { ORGANIZATIONS_BULK_FIELDS } from "@/lib/bulk-fields";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateOrganizationDialog } from "@/components/create-funder-dialog";
import { PriorityStar } from "@/components/priority-star";
import { PriorityTooltip } from "@/components/priority-tooltip";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { RegionMultiFilter } from "@/components/region-multi-filter";
import { INTERESTS_THEMATIC_SUGGESTIONS } from "@/components/multi-select-picker";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useUserNameMap } from "@/components/user-picker";
import { canSeeIdentity, displayOrganizationName, ANONYMOUS_LABEL, type Viewer } from "@/lib/visibility";
import { useRegionNameMap } from "@/components/region-picker";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { PageJumper } from "@/components/page-jumper";

// Derive the Type filter options from the generated `EntityType` enum so the
// filter can never drift from the values records actually use. Enum insertion
// order already groups grant-maker/foundation types first, then the rest;
// `MultiFilterSelect` auto-labels these raw slugs via `formatEnum`.
const SUBTYPES: string[] = Object.values(EntityType);

// The Type filter is unfiltered by default — all organization types show
// until the user opts into a subset.
const DEFAULT_SUBTYPES: string[] = [];

const ACTIVE_STATUSES: ActiveStatus[] = ["active", "defunct", "spenddown"];
// The explicit active-status filter is opt-in and unfiltered by default; the
// "Show defunct" toggle now governs defunct visibility instead.
const DEFAULT_ACTIVE_STATUSES: ActiveStatus[] = [];
// Sent when "Show defunct" is off and no explicit active-status filter is
// applied: every non-defunct status plus the blank sentinel so null-status
// organizations (which aren't defunct) still appear.
const NON_DEFUNCT_STATUS_PARAM: string[] = ["active", "spenddown", "__blank__"];
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

const NONE = "__none__";
type OrgDraft = {
  priority: string;
  capacityRating: string;
  connectionStatus: string;
  enthusiasm: string;
  strategicAlignment: string;
};

type InlineCtx = {
  editingId: string | null;
  draft: OrgDraft | null;
  isEditing: (id: string) => boolean;
  patch: (partial: Partial<OrgDraft>) => void;
  save: () => void;
  cancel: () => void;
  saving: boolean;
};

const PAGE_SIZE = 50;
const PRIORITY_LABEL: Record<string, string> = { top: "Top", high: "High", medium: "Medium", low: "Low" };

type ColCtx = {
  userNames: Map<string, string>;
  regionNames: Map<string, string>;
  viewer: Viewer;
  isAdmin: boolean;
  inline: InlineCtx;
  onOpen: (f: Organization) => void;
  onStartEdit: (f: Organization) => void;
  onArchive: (f: Organization) => void;
  onUnarchive: (f: Organization) => void;
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
      label: "Priority",
      header: (
        <span className="inline-flex items-center gap-1">
          Priority
          <PriorityTooltip />
        </span>
      ),
      cell: (f) =>
        ctx.inline.isEditing(f.id) ? (
          <Select
            value={ctx.inline.draft?.priority ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ priority: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Priority tier"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-priority-org-${f.id}`}
            >
              <SelectValue placeholder="Priority tier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {PRIORITIES.map((pr) => (
                <SelectItem key={pr} value={pr}>
                  {PRIORITY_LABEL[pr] ?? pr}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : f.priority ? (
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
      key: "issuesGrants",
      label: "Grant-making",
      defaultVisible: false,
      cell: (f) => (f.issuesGrants ? "Yes" : "No"),
    },
    {
      key: "makesPris",
      label: "Makes PRIs",
      defaultVisible: false,
      cell: (f) => (f.makesPris == null ? "—" : f.makesPris ? "Yes" : "No"),
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
      cell: (f) =>
        ctx.inline.isEditing(f.id) ? (
          <Select
            value={ctx.inline.draft?.connectionStatus ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ connectionStatus: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Connection"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-connection-org-${f.id}`}
            >
              <SelectValue placeholder="Connection" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {CONNECTION_STATUSES.map((c) => (
                <SelectItem key={c} value={c}>
                  {formatEnum(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          formatEnum(f.connectionStatus)
        ),
    },
    {
      key: "enthusiasm",
      label: "Enthusiasm",
      cell: (f) =>
        ctx.inline.isEditing(f.id) ? (
          <Select
            value={ctx.inline.draft?.enthusiasm ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ enthusiasm: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Enthusiasm"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-enthusiasm-org-${f.id}`}
            >
              <SelectValue placeholder="Enthusiasm" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {ENTHUSIASM_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          formatEnthusiasm(f.enthusiasm)
        ),
    },
    {
      key: "strategicAlignment",
      label: "Strategic alignment",
      cell: (f) =>
        ctx.inline.isEditing(f.id) ? (
          <Select
            value={ctx.inline.draft?.strategicAlignment ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ strategicAlignment: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Strategic alignment"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-strategic-org-${f.id}`}
            >
              <SelectValue placeholder="Strategic alignment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {STRATEGIC_ALIGNMENTS.map((s) => (
                <SelectItem key={s} value={s}>
                  {formatEnum(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          formatEnum(f.strategicAlignment)
        ),
    },
    {
      key: "capacity",
      label: "Capacity",
      cell: (f) =>
        ctx.inline.isEditing(f.id) ? (
          <Select
            value={ctx.inline.draft?.capacityRating ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ capacityRating: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Capacity"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-capacity-org-${f.id}`}
            >
              <SelectValue placeholder="Capacity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {CAPACITY_TIERS.map((t) => (
                <SelectItem key={t} value={t}>
                  {formatCapacity(t) ?? t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          formatCapacity(f.capacityRating)
        ),
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
    {
      key: "actions",
      label: "",
      required: true,
      sortable: false,
      align: "right",
      thClassName: "w-32",
      tdClassName: "text-right",
      cell: (f) =>
        ctx.inline.isEditing(f.id) ? (
          <InlineRowSaveActions
            onSave={ctx.inline.save}
            onCancel={ctx.inline.cancel}
            saving={ctx.inline.saving}
            testIdPrefix={`org-${f.id}`}
          />
        ) : (
          <RowActionIcons
            entityLabel={
              canSeeIdentity(f, ctx.viewer)
                ? formatOrganizationNameShort(f.name)
                : ANONYMOUS_LABEL
            }
            testIdPrefix={`org-${f.id}`}
            disabled={ctx.inline.editingId !== null}
            archived={!!f.archivedAt}
            onOpen={() => ctx.onOpen(f)}
            onEdit={() => ctx.onStartEdit(f)}
            onArchive={
              f.archivedAt
                ? ctx.isAdmin
                  ? () => ctx.onUnarchive(f)
                  : undefined
                : () => ctx.onArchive(f)
            }
          />
        ),
    },
  ];
}

export default function Organizations() {
  const [, navigate] = useLocation();
  // Filter state persists per-tab so back-navigation from a funder
  // detail restores the same filtered view.
  const [search, setSearch] = usePersistedState<string>("wf.list.funders.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [issuesGrants, setIssuesGrants] = usePersistedState<boolean | undefined>("wf.list.funders.issuesGrants", undefined);
  const [makesPris, setMakesPris] = usePersistedState<boolean | undefined>("wf.list.funders.makesPris", undefined);
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
  const [interestsThematicSel, setInterestsThematicSel] = usePersistedState<string[]>("wf.list.funders.interestsThematic", []);
  const [regionIdsSel, setRegionIdsSel] = usePersistedState<string[]>("wf.list.funders.regionIds", []);
  const [showDefunct, setShowDefunct] = usePersistedState<boolean>("wf.list.funders.showDefunct", false);
  const [page, setPage] = usePersistedState<number>("wf.list.funders.page", 1);
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    "wf.list.funders.columns",
    null,
  );
  const [filtersState, setFiltersState] = usePersistedState<FiltersState | null>(
    "wf.list.funders.filters",
    null,
  );
  const [viewMode, setViewMode] = usePersistedState<"list" | "kanban">("wf.list.funders.view", "list");
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const bulkMut = useBulkUpdateOrganizations();
  const bulkArchiveMut = useBulkArchiveOrganizations();
  const archiveMut = useArchiveOrganization();
  const unarchiveMut = useUnarchiveOrganization();
  const [mergeOpen, setMergeOpen] = useState(false);
  const mergeMut = useMergeOrganizations();
  const queryClient = useQueryClient();
  const updateOrganization = useUpdateOrganization();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [showArchived, setShowArchived] = usePersistedState<boolean>(
    "wf.list.funders.showArchived",
    false,
  );

  const ts = useTableState("funding-entities");
  const sortActive = ts.sort.key !== null;
  const params: ListOrganizationsParams = {
    limit: viewMode === "kanban" ? 500 : (sortActive ? 10000 : PAGE_SIZE),
    page: viewMode === "kanban" ? 1 : (sortActive ? 1 : page),
    ...(isAdmin && showArchived ? { includeArchived: true } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(issuesGrants !== undefined ? { issuesGrants } : {}),
    ...(makesPris !== undefined ? { makesPris } : {}),
    ...(subtypes.length > 0 ? { entityType: [...subtypes].sort() } : {}),
    // Explicit active-status filter wins; otherwise "Show defunct" governs:
    // off hides defunct only (null-status orgs still show), on adds no filter.
    ...(activeStatuses.length > 0
      ? { activeStatus: [...activeStatuses].sort() as ActiveStatus[] }
      : showDefunct
        ? {}
        : { activeStatus: NON_DEFUNCT_STATUS_PARAM as ActiveStatus[] }),
    // Kanban view groups columns by connection status + enthusiasm, so those
    // filters would just narrow the board — never apply them there.
    ...(viewMode !== "kanban" && connectionStatuses.length > 0
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
    ...(viewMode !== "kanban" && enthusiasms.length > 0
      ? { enthusiasm: [...enthusiasms].sort() }
      : {}),
    ...(strategicAlignments.length > 0 ? { strategicAlignment: [...strategicAlignments].sort() } : {}),
    ...(interestsThematicSel.length > 0 ? { interestsThematic: [...interestsThematicSel].sort() } : {}),
    ...(regionIdsSel.length > 0 ? { regionIds: [...regionIdsSel].sort() } : {}),
  };

  const { data, isLoading, isError, error } = useListOrganizations(params, {
    query: { queryKey: getListOrganizationsQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const kanbanTruncated = viewMode === "kanban" && total > rows.length;
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
  function handleOrgMove(id: string, patch: EntityKanbanPatch) {
    queryClient.setQueryData<{ data: Organization[]; pagination: { page: number; limit: number; total: number } }>(
      getListOrganizationsQueryKey(params),
      (prev) => prev ? { ...prev, data: prev.data.map((o) => o.id === id ? { ...o, ...patch } as Organization : o) } : prev,
    );
    updateOrganization.mutate(
      { id, data: { connectionStatus: (patch.connectionStatus ?? null) as ConnectionStatus | null, enthusiasm: (patch.enthusiasm ?? null) as Enthusiasm | null } },
      { onSettled: () => queryClient.invalidateQueries({ queryKey: getListOrganizationsQueryKey() }) },
    );
  }
  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: getListOrganizationsQueryKey() }),
    [queryClient],
  );

  const inlineEdit = useInlineRowEdit<Organization, OrgDraft>({
    getId: (f) => f.id,
    toDraft: (f) => ({
      priority: f.priority ?? NONE,
      capacityRating: f.capacityRating ?? NONE,
      connectionStatus: f.connectionStatus ?? NONE,
      enthusiasm: f.enthusiasm ?? NONE,
      strategicAlignment: f.strategicAlignment ?? NONE,
    }),
    onSave: async (id, d) => {
      await updateOrganization.mutateAsync({
        id,
        data: {
          priority: d.priority === NONE ? null : (d.priority as Priority),
          capacityRating:
            d.capacityRating === NONE
              ? null
              : (d.capacityRating as CapacityRating),
          connectionStatus:
            d.connectionStatus === NONE
              ? null
              : (d.connectionStatus as ConnectionStatus),
          enthusiasm:
            d.enthusiasm === NONE ? null : (d.enthusiasm as Enthusiasm),
          strategicAlignment:
            d.strategicAlignment === NONE
              ? null
              : (d.strategicAlignment as StrategicAlignment),
        },
      });
      await refreshList();
      toast({ title: "Organization updated" });
    },
  });

  const archiveOrg = (f: Organization) =>
    archiveMut.mutate(
      { id: f.id },
      {
        onSuccess: async () => {
          await refreshList();
          selection.removeMany([f.id]);
          toast({ title: "Organization archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const unarchiveOrg = (f: Organization) =>
    unarchiveMut.mutate(
      { id: f.id },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Organization unarchived" });
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
    () =>
      buildColumns({
        userNames,
        regionNames,
        viewer,
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
        onOpen: (f) => navigate(`/organizations/${f.id}`),
        onStartEdit: (f) => inlineEdit.start(f),
        onArchive: archiveOrg,
        onUnarchive: unarchiveOrg,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userNames, regionNames, viewer, isAdmin, inlineEdit, navigate],
  );
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
    () => {
      const defs: FilterDef[] = [
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
        key: "makesPris",
        label: "Makes PRIs",
        defaultVisible: false,
        active: makesPris !== undefined,
        clear: () => { setMakesPris(undefined); setPage(1); selection.clear(); },
        render: () => (
          <select
            className="h-8 rounded border px-2 text-sm bg-background"
            value={makesPris === undefined ? "" : String(makesPris)}
            onChange={(e) => {
              const v = e.target.value;
              setMakesPris(v === "" ? undefined : v === "true");
              setPage(1);
              selection.clear();
            }}
            data-testid="select-makes-pris"
          >
            <option value="">All organizations</option>
            <option value="true">Makes PRIs only</option>
            <option value="false">Doesn't make PRIs only</option>
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
            label="Type"
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
        defaultVisible: false,
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
        key: "interestsThematic",
        label: "Interests",
        active: interestsThematicSel.length > 0,
        clear: () => { setInterestsThematicSel([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Interests"
            selected={interestsThematicSel}
            onChange={(v) => { setInterestsThematicSel(v); setPage(1); selection.clear(); }}
            options={INTERESTS_THEMATIC_SUGGESTIONS.map((o) => ({ value: o.value, label: o.label }))}
            testId="select-funder-interests"
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
      ];
      // Kanban view groups columns by connection status + enthusiasm, so those
      // filters are redundant there — hide them from both the chooser and the
      // filter row (the params builder likewise omits their values in kanban).
      return viewMode === "kanban"
        ? defs.filter((d) => d.key !== "connection" && d.key !== "enthusiasm")
        : defs;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [issuesGrants, makesPris, subtypes, activeStatuses, connectionStatuses, priorities, owners, lifetimeGivingPresence, openAsksPresence, primaryContactPresence, sameDefaultSubtypes, sameDefaultActiveStatuses, capacityTiers, enthusiasms, strategicAlignments, interestsThematicSel, regionIdsSel, viewMode],
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
    makesPris !== undefined ||
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
    interestsThematicSel.length > 0 ||
    regionIdsSel.length > 0;

  // ─── Saved views ─────────────────────────────────────────────────
  type FundersView = {
    search: string;
    issuesGrants: boolean | undefined;
    makesPris: boolean | undefined;
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
    interestsThematicSel: string[];
    regionIdsSel: string[];
    sort: SortState;
    columns: ColumnsState | null;
    filters: FiltersState | null;
  };
  const currentView: FundersView = {
    search,
    issuesGrants,
    makesPris,
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
    interestsThematicSel,
    regionIdsSel,
    sort: ts.sort,
    columns: columnsState,
    filters: filtersState,
  };
  const clearAll = () => {
    setSearch("");
    setIssuesGrants(undefined);
    setMakesPris(undefined);
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
    setInterestsThematicSel([]);
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
      setMakesPris(s.makesPris ?? undefined);
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
      setInterestsThematicSel(s.interestsThematicSel ?? []);
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
        s.makesPris === undefined &&
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
        (s.interestsThematicSel?.length ?? 0) === 0 &&
        (s.regionIdsSel?.length ?? 0) === 0 &&
        (s.sort?.key ?? null) === null &&
        (s.columns ?? null) === null &&
        (s.filters ?? null) === null
      );
    },
  });

  return (
    <div className="space-y-6">
      <ListPageHeader
        title="Organizations"
        subtitle={isLoading ? <Skeleton className="h-4 w-20" /> : `${total.toLocaleString()} total`}
        addAction={<CreateOrganizationDialog />}
        controls={
          <>
            <ShowArchivedToggle
              value={showArchived}
              onChange={(v) => {
                setShowArchived(v);
                setPage(1);
                selection.clear();
              }}
              testId="toggle-show-archived-organizations"
            />
            <div className="flex items-center gap-2">
              <Switch
                id="toggle-show-defunct-organizations"
                checked={showDefunct}
                onCheckedChange={(v) => {
                  setShowDefunct(v);
                  setPage(1);
                  selection.clear();
                }}
                data-testid="toggle-show-defunct-organizations"
              />
              <Label
                htmlFor="toggle-show-defunct-organizations"
                className="cursor-pointer text-sm text-muted-foreground whitespace-nowrap"
              >
                Show defunct
              </Label>
            </div>
            <div className="flex rounded-md border overflow-hidden">
              <Button
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none border-0 px-2"
                onClick={() => setViewMode("list")}
                title="List view"
                aria-label="Switch to list view"
              >
                <LayoutList className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "kanban" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none border-0 px-2"
                onClick={() => setViewMode("kanban")}
                title="Kanban view"
                aria-label="Switch to kanban view"
              >
                <Columns3 className="h-4 w-4" />
              </Button>
            </div>
            <FiltersMenu
              registry={filterRegistry}
              state={filtersState}
              onChange={setFiltersState}
            />
            {viewMode === "list" && (
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

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <div className="relative">
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
              className="pr-8"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="no-default-hover-elevate no-default-active-elevate absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearch("");
                  setPage(1);
                  selection.clear();
                }}
                aria-label="Clear search"
                data-testid="button-clear-search-funders"
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
              setIssuesGrants(undefined);
              setMakesPris(undefined);
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
              setInterestsThematicSel([]);
              setRegionIdsSel([]);
              setPage(1);
              selection.clear();
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {viewMode === "kanban" ? (
        <EntityKanban
          rows={rows}
          isLoading={isLoading}
          isError={isError}
          error={error}
          truncated={kanbanTruncated}
          onMove={handleOrgMove}
          renderCard={(org, { hidden, isOverlay }) => (
            <DraggableCard id={org.id} hidden={hidden} isOverlay={isOverlay}>
              <Link
                href={`/organizations/${org.id}`}
                className="font-medium text-foreground hover:text-primary line-clamp-1 text-sm"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {canSeeIdentity(org, viewer) ? displayOrganizationName(org, viewer) : ANONYMOUS_LABEL}
              </Link>
              <div className="mt-1 text-xs text-muted-foreground">
                {formatEnum(org.entityType)}
              </div>
            </DraggableCard>
          )}
        />
      ) : (
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
              <SkeletonRows cols={colSpan} />
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
      )}

      {viewMode === "list" && (
        <BulkActionBar
          count={selection.count}
          onEdit={() => setBulkOpen(true)}
          onMerge={() => setMergeOpen(true)}
          onArchive={() => setBulkArchiveOpen(true)}
          onClear={selection.clear}
          entityNoun="organization"
        />
      )}
      <BulkArchiveDialog
        open={bulkArchiveOpen}
        onOpenChange={setBulkArchiveOpen}
        entityNoun="organization"
        selectedIds={selection.selectedIds}
        invalidateKeys={[getListOrganizationsQueryKey()]}
        onConfirm={async () =>
          bulkArchiveMut.mutateAsync({ data: { ids: selection.selectedIds } })
        }
        onDone={(r) => selection.removeMany(r.succeededIds)}
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

      {viewMode === "list" && totalPages > 1 && (
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
              <PageJumper
                page={page}
                totalPages={totalPages}
                onJump={setPage}
                className="mx-2"
              />
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
