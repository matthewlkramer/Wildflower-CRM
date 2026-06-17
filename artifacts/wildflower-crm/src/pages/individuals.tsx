import { useCallback, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPeople,
  getListPeopleQueryKey,
  useBulkUpdatePeople,
  useBulkArchivePeople,
  useArchivePerson,
  useUnarchivePerson,
  useMergePeople,
  useGetCurrentUser,
  getGetPersonQueryOptions,
  getGetPersonQueryKey,
  useUpdatePerson,
  type ListPeopleParams,
  type CapacityRating,
  type ConnectionStatus,
  type Enthusiasm,
  type Priority,
  type Person,
} from "@workspace/api-client-react";
import { LayoutList, Columns3 } from "lucide-react";
import { EntityKanban, DraggableCard, type EntityKanbanPatch } from "@/components/entity-kanban";
import { MergeDialog, type MergeField, type MergeRecord } from "@/components/merge-dialog";
import { canSeeIdentity, displayPersonName, ANONYMOUS_LABEL, type Viewer } from "@/lib/visibility";
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
import { PEOPLE_BULK_FIELDS } from "@/lib/bulk-fields";
import { Checkbox } from "@/components/ui/checkbox";
import {
  RowActionIcons,
  InlineRowSaveActions,
} from "@/components/row-action-icons";
import { ShowArchivedToggle } from "@/components/show-archived-toggle";
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
import {
  formatCapacity,
  formatCurrency,
  formatDateShort,
  formatEnum,
  formatEnthusiasm,
  formatOrganizationNameShort,
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
import { RegionMultiFilter } from "@/components/region-multi-filter";
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
const PRIORITIES = ["top", "high", "medium", "low"] as const;
const CONNECTION_STATUSES: ConnectionStatus[] = ["connected", "have_a_connector", "no_connection"];
const ENTHUSIASM_OPTIONS = [
  { value: "7-advocate", label: "7-Advocate" },
  { value: "6-supportive", label: "6-Supportive" },
  { value: "5-warm", label: "5-Warm" },
  { value: "4-neutral", label: "4-Neutral" },
  { value: "3-cool", label: "3-Cool" },
  { value: "2-unsupportive", label: "2-Unsupportive" },
  { value: "1-hostile", label: "1-Hostile" },
] as const;
// Derived newsletter status. `unsubscribed` wins over the `newsletter`
// flag so the three states are mutually exclusive (matches the detail
// page + the server-side filter + Flodesk precedence).
const NEWSLETTER_OPTIONS: MultiFilterOption[] = [
  { value: "subscribed", label: "Subscribed" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "not_subscribed", label: "Not subscribed" },
];
type NewsletterStatus = "subscribed" | "unsubscribed" | "not_subscribed";
function newsletterStatus(p: Person): NewsletterStatus {
  if (p.unsubscribedToNewsletter) return "unsubscribed";
  if (p.newsletter) return "subscribed";
  return "not_subscribed";
}
const NEWSLETTER_SORT: Record<NewsletterStatus, number> = {
  subscribed: 2,
  not_subscribed: 1,
  unsubscribed: 0,
};

// Inline-edit draft for the per-row pencil. Only the simple enum cells are
// editable inline; everything relational lives on the detail page. "__none__"
// is the sentinel for "clear this enum" (Radix Select forbids an empty value).
const NONE = "__none__";
type PersonDraft = {
  priority: string;
  capacityRating: string;
  connectionStatus: string;
  enthusiasm: string;
};

type InlineCtx = {
  editingId: string | null;
  draft: PersonDraft | null;
  isEditing: (id: string) => boolean;
  patch: (partial: Partial<PersonDraft>) => void;
  save: () => void;
  cancel: () => void;
  saving: boolean;
};

// Lookups the column cell renderers close over. Bundled into a single
// context object so `buildColumns` stays a pure function of its inputs
// (easier to memoize, easier to read).
type ColCtx = {
  regionNames: Map<string, string>;
  userNames: Map<string, string>;
  viewer: Viewer;
  isAdmin: boolean;
  inline: InlineCtx;
  onOpen: (p: Person) => void;
  onStartEdit: (p: Person) => void;
  onArchive: (p: Person) => void;
  onUnarchive: (p: Person) => void;
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
          {canSeeIdentity(p, ctx.viewer) ? personDisplayName(p) : ANONYMOUS_LABEL}
        </Link>
      ),
    },
    {
      key: "priorityTier",
      label: "Priority tier",
      cell: (p) =>
        ctx.inline.isEditing(p.id) ? (
          <Select
            value={ctx.inline.draft?.priority ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ priority: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Priority"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-priority-person-${p.id}`}
            >
              <SelectValue placeholder="Priority" />
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
        ) : p.priority ? (
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
      cell: (p) =>
        ctx.inline.isEditing(p.id) ? (
          <Select
            value={ctx.inline.draft?.capacityRating ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ capacityRating: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Capacity"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-capacity-person-${p.id}`}
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
          formatCapacity(p.capacityRating)
        ),
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
        const activeFunders = p.activeOrganizationNames ?? [];
        if (activeFunders.length > 0)
          return activeFunders.map(formatOrganizationNameShort).join(", ");

        const activeOrgs = p.activeOrganizationNames ?? [];
        if (activeOrgs.length > 0)
          return (
            <span className="text-muted-foreground/70">
              {activeOrgs.join(", ")}
            </span>
          );

        const pastFunders = (p.pastOrganizationNames ?? []).map(formatOrganizationNameShort);
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
      key: "newsletter",
      label: "Newsletter",
      defaultVisible: false,
      cell: (p) => {
        const s = newsletterStatus(p);
        if (s === "subscribed")
          return <Badge variant="outline">Subscribed</Badge>;
        if (s === "unsubscribed")
          return (
            <Badge variant="outline" className="text-muted-foreground">
              Unsubscribed
            </Badge>
          );
        return "—";
      },
    },
    {
      key: "connectionStatus",
      label: "Connection",
      defaultVisible: false,
      cell: (p) =>
        ctx.inline.isEditing(p.id) ? (
          <Select
            value={ctx.inline.draft?.connectionStatus ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ connectionStatus: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Connection"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-connection-person-${p.id}`}
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
          formatEnum(p.connectionStatus)
        ),
    },
    {
      key: "enthusiasm",
      label: "Enthusiasm",
      defaultVisible: false,
      cell: (p) =>
        ctx.inline.isEditing(p.id) ? (
          <Select
            value={ctx.inline.draft?.enthusiasm ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ enthusiasm: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Enthusiasm"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-enthusiasm-person-${p.id}`}
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
          formatEnthusiasm(p.enthusiasm)
        ),
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
    {
      key: "actions",
      label: "",
      required: true,
      sortable: false,
      align: "right",
      thClassName: "w-32",
      tdClassName: "text-right",
      cell: (p) =>
        ctx.inline.isEditing(p.id) ? (
          <InlineRowSaveActions
            onSave={ctx.inline.save}
            onCancel={ctx.inline.cancel}
            saving={ctx.inline.saving}
            testIdPrefix={`person-${p.id}`}
          />
        ) : (
          <RowActionIcons
            entityLabel={
              canSeeIdentity(p, ctx.viewer)
                ? personDisplayName(p)
                : ANONYMOUS_LABEL
            }
            testIdPrefix={`person-${p.id}`}
            disabled={ctx.inline.editingId !== null}
            archived={!!p.archivedAt}
            onOpen={() => ctx.onOpen(p)}
            onEdit={() => ctx.onStartEdit(p)}
            onArchive={
              p.archivedAt
                ? ctx.isAdmin
                  ? () => ctx.onUnarchive(p)
                  : undefined
                : () => ctx.onArchive(p)
            }
          />
        ),
    },
  ];
}

export default function Individuals() {
  const [, navigate] = useLocation();
  // Filter state persists per-tab so back-navigation from a person
  // detail page restores the same filtered view.
  const [search, setSearch] = usePersistedState<string>("wf.list.people.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [deceasedSel, setDeceasedSel] = usePersistedState<string[]>("wf.list.people.deceased", []);
  const [capacityTiers, setCapacityTiers] = usePersistedState<string[]>("wf.list.people.capacity", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.people.owners", []);
  // Presence filters on computed rollup columns (has value vs blank).
  const [lifetimeGivingPresence, setLifetimeGivingPresence] = usePersistedState<PresenceValue>("wf.list.people.f.lifetimeGiving", undefined);
  const [lastGiftPresence, setLastGiftPresence] = usePersistedState<PresenceValue>("wf.list.people.f.lastGift", undefined);
  const [openAsksPresence, setOpenAsksPresence] = usePersistedState<PresenceValue>("wf.list.people.f.openAsks", undefined);
  const [activeAffiliationPresence, setActiveAffiliationPresence] = usePersistedState<PresenceValue>("wf.list.people.f.activeAffiliation", undefined);
  const [connectionStatusSel, setConnectionStatusSel] = usePersistedState<string[]>("wf.list.people.connectionStatuses", []);
  const [enthusiasmSel, setEnthusiasmSel] = usePersistedState<string[]>("wf.list.people.enthusiasms", []);
  const [prioritySel, setPrioritySel] = usePersistedState<string[]>("wf.list.people.priorities", []);
  const [regionIdsSel, setRegionIdsSel] = usePersistedState<string[]>("wf.list.people.regionIds", []);
  const [newsletterSel, setNewsletterSel] = usePersistedState<string[]>("wf.list.people.newsletter", []);
  // Which optional filters are shown in the toolbar. null = registry defaults.
  const [filtersState, setFiltersState] = usePersistedState<FiltersState | null>("wf.list.people.filters", null);
  const [page, setPage] = usePersistedState<number>("wf.list.people.page", 1);
  // Column customization: null = use registry defaults. Shape is
  // round-tripped through saved views, so changes here also persist
  // per-view when the user saves one.
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    "wf.list.people.columns",
    null,
  );
  const [viewMode, setViewMode] = usePersistedState<"list" | "kanban">("wf.list.people.view", "list");
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const bulkMut = useBulkUpdatePeople();
  const bulkArchiveMut = useBulkArchivePeople();
  const archiveMut = useArchivePerson();
  const unarchiveMut = useUnarchivePerson();
  const [mergeOpen, setMergeOpen] = useState(false);
  const mergeMut = useMergePeople();
  const queryClient = useQueryClient();
  const updatePerson = useUpdatePerson();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [showArchived, setShowArchived] = usePersistedState<boolean>(
    "wf.list.people.showArchived",
    false,
  );

  const ts = useTableState("individuals");
  const sortActive = ts.sort.key !== null;
  const params: ListPeopleParams = {
    limit: viewMode === "kanban" ? 500 : (sortActive ? 10000 : PAGE_SIZE),
    page: viewMode === "kanban" ? 1 : (sortActive ? 1 : page),
    ...(isAdmin && showArchived ? { includeArchived: true } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    // Only send the boolean when exactly one option is picked. 0 or 2 = unfiltered.
    ...(deceasedSel.length === 1
      ? { deceased: deceasedSel[0] === "true" }
      : {}),
    ...(capacityTiers.length > 0
      ? { capacityRating: [...capacityTiers].sort() as CapacityRating[] }
      : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(lifetimeGivingPresence ? { lifetimeGivingPresence } : {}),
    ...(lastGiftPresence ? { lastGiftPresence } : {}),
    ...(openAsksPresence ? { openAsksPresence } : {}),
    ...(activeAffiliationPresence ? { activeAffiliationPresence } : {}),
    ...(connectionStatusSel.length > 0
      ? { connectionStatus: [...connectionStatusSel].sort() as ConnectionStatus[] }
      : {}),
    ...(enthusiasmSel.length > 0 ? { enthusiasm: [...enthusiasmSel].sort() } : {}),
    ...(prioritySel.length > 0 ? { priority: [...prioritySel].sort() } : {}),
    ...(regionIdsSel.length > 0 ? { regionIds: [...regionIdsSel].sort() } : {}),
    ...(newsletterSel.length > 0
      ? { newsletterStatus: [...newsletterSel].sort() as NewsletterStatus[] }
      : {}),
  };

  const { data, isLoading, isError, error } = useListPeople(params, {
    query: { queryKey: getListPeopleQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const kanbanTruncated = viewMode === "kanban" && total > rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const regionNames = useRegionNameMap();
  const userNames = useUserNameMap();

  // Fetch full records for the merge dialog only while it's open.
  const mergeIds = mergeOpen ? selection.selectedIds : [];
  const mergeQueries = useQueries({
    queries: mergeIds.map((id) =>
      getGetPersonQueryOptions(id, {
        query: {
          enabled: mergeOpen,
          staleTime: 30_000,
          queryKey: getGetPersonQueryKey(id),
        },
      }),
    ),
  });
  const mergeRecords = useMemo<MergeRecord[]>(
    () =>
      mergeQueries
        .map((q) => q.data)
        .filter((d): d is Person => !!d)
        .map((d) => d as unknown as MergeRecord),
    [mergeQueries],
  );
  const mergeLoading = mergeOpen && mergeQueries.some((q) => q.isLoading);

  const mergeFields = useMemo<MergeField[]>(
    () => [
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "fullName", label: "Full name" },
      { key: "nickname", label: "Nickname" },
      { key: "pronouns", label: "Pronouns" },
      { key: "capacityRating", label: "Capacity", display: (v) => formatCapacity(v as string | null) },
      { key: "connectionStatus", label: "Connection", display: (v) => formatEnum(v as string | null) },
      { key: "enthusiasm", label: "Enthusiasm", display: (v) => formatEnthusiasm(v as string | null) },
      { key: "priority", label: "Priority", display: (v) => formatEnum(v as string | null) },
      { key: "deceased", label: "Deceased", display: (v) => (v == null ? "—" : v ? "Yes" : "No") },
      {
        key: "currentHomeRegionId",
        label: "Home region",
        display: (v) => (v ? (regionNames.get(v as string) ?? String(v)) : "—"),
      },
      {
        key: "ownerUserId",
        label: "Owner",
        display: (v) => (v ? (userNames.get(v as string) ?? String(v)) : "—"),
      },
      { key: "lastContacted", label: "Last contacted", display: (v) => formatDateShort(v as string | null) },
      { key: "website", label: "Website" },
      { key: "linkedin", label: "LinkedIn" },
    ],
    [regionNames, userNames],
  );

  const mergeLabel = (r: MergeRecord): string => {
    const p = r as unknown as Person;
    return (
      (p.fullName as string | null) ||
      [p.firstName, p.lastName].filter(Boolean).join(" ") ||
      p.id
    );
  };

  const viewer = useGetCurrentUser().data ?? null;
  function handlePersonMove(id: string, patch: EntityKanbanPatch) {
    queryClient.setQueryData<{ data: Person[]; pagination: { page: number; limit: number; total: number } }>(
      getListPeopleQueryKey(params),
      (prev) => prev ? { ...prev, data: prev.data.map((p) => p.id === id ? { ...p, ...patch } as Person : p) } : prev,
    );
    updatePerson.mutate(
      { id, data: { connectionStatus: (patch.connectionStatus ?? null) as ConnectionStatus | null, enthusiasm: (patch.enthusiasm ?? null) as Enthusiasm | null } },
      { onSettled: () => queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() }) },
    );
  }
  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() }),
    [queryClient],
  );

  const inlineEdit = useInlineRowEdit<Person, PersonDraft>({
    getId: (p) => p.id,
    toDraft: (p) => ({
      priority: p.priority ?? NONE,
      capacityRating: p.capacityRating ?? NONE,
      connectionStatus: p.connectionStatus ?? NONE,
      enthusiasm: p.enthusiasm ?? NONE,
    }),
    onSave: async (id, d) => {
      await updatePerson.mutateAsync({
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
        },
      });
      await refreshList();
      toast({ title: "Person updated" });
    },
  });

  const archivePerson = (p: Person) =>
    archiveMut.mutate(
      { id: p.id },
      {
        onSuccess: async () => {
          await refreshList();
          selection.removeMany([p.id]);
          toast({ title: "Person archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const unarchivePerson = (p: Person) =>
    unarchiveMut.mutate(
      { id: p.id },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Person unarchived" });
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
        regionNames,
        userNames,
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
        onOpen: (p) => navigate(`/individuals/${p.id}`),
        onStartEdit: (p) => inlineEdit.start(p),
        onArchive: archivePerson,
        onUnarchive: unarchivePerson,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regionNames, userNames, viewer, isAdmin, inlineEdit, navigate],
  );
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 1; // +1 for the checkbox column

  // Filter registry — every toolbar filter control, toggleable via the
  // FiltersMenu. Enum filters default visible; presence filters on
  // computed columns are opt-in (defaultVisible:false). Each def's
  // `clear` resets its value so hiding an active filter stops narrowing.
  const filterRegistry = useMemo<FilterDef[]>(
    () => [
      {
        key: "status",
        label: "Status",
        active: deceasedSel.length > 0,
        clear: () => { setDeceasedSel([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Status"
            selected={deceasedSel}
            onChange={(v) => { setDeceasedSel(v); setPage(1); selection.clear(); }}
            options={DECEASED_OPTIONS}
            testId="select-deceased"
          />
        ),
      },
      {
        key: "capacity",
        label: "Capacity",
        active: capacityTiers.length > 0,
        clear: () => { setCapacityTiers([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Capacity"
            selected={capacityTiers}
            onChange={(v) => { setCapacityTiers(v); setPage(1); selection.clear(); }}
            options={CAPACITY_TIERS.map((t) => ({ value: t, label: formatCapacity(t) ?? t }))}
            testId="select-capacity"
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
            testId="select-person-owner"
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
        key: "lastGift",
        label: "Last gift",
        defaultVisible: false,
        active: !!lastGiftPresence,
        clear: () => { setLastGiftPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Last gift"
            value={lastGiftPresence}
            onChange={(v) => { setLastGiftPresence(v); setPage(1); selection.clear(); }}
            testId="filter-last-gift"
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
        key: "activeAffiliation",
        label: "Active funders / orgs",
        defaultVisible: false,
        active: !!activeAffiliationPresence,
        clear: () => { setActiveAffiliationPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Active funders / orgs"
            value={activeAffiliationPresence}
            onChange={(v) => { setActiveAffiliationPresence(v); setPage(1); selection.clear(); }}
            testId="filter-active-affiliation"
          />
        ),
      },
      {
        key: "connectionStatus",
        label: "Connection",
        defaultVisible: false,
        active: connectionStatusSel.length > 0,
        clear: () => { setConnectionStatusSel([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Connection"
            selected={connectionStatusSel}
            onChange={(v) => { setConnectionStatusSel(v); setPage(1); selection.clear(); }}
            options={CONNECTION_STATUSES}
            testId="select-person-connection"
            includeBlank
          />
        ),
      },
      {
        key: "enthusiasm",
        label: "Enthusiasm",
        defaultVisible: false,
        active: enthusiasmSel.length > 0,
        clear: () => { setEnthusiasmSel([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Enthusiasm"
            selected={enthusiasmSel}
            onChange={(v) => { setEnthusiasmSel(v); setPage(1); selection.clear(); }}
            options={[...ENTHUSIASM_OPTIONS]}
            testId="select-person-enthusiasm"
            includeBlank
          />
        ),
      },
      {
        key: "priority",
        label: "Priority",
        defaultVisible: false,
        active: prioritySel.length > 0,
        clear: () => { setPrioritySel([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Priority"
            selected={prioritySel}
            onChange={(v) => { setPrioritySel(v); setPage(1); selection.clear(); }}
            options={[...PRIORITIES]}
            testId="select-person-priority"
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
            testId="select-person-region"
          />
        ),
      },
      {
        key: "newsletter",
        label: "Newsletter",
        defaultVisible: false,
        active: newsletterSel.length > 0,
        clear: () => { setNewsletterSel([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Newsletter"
            selected={newsletterSel}
            onChange={(v) => { setNewsletterSel(v); setPage(1); selection.clear(); }}
            options={NEWSLETTER_OPTIONS}
            testId="select-person-newsletter"
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deceasedSel, capacityTiers, owners, lifetimeGivingPresence, lastGiftPresence, openAsksPresence, activeAffiliationPresence, connectionStatusSel, enthusiasmSel, prioritySel, regionIdsSel, newsletterSel],
  );
  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
  );

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
          name: (r) => displayPersonName(r, viewer).toLowerCase(),
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
          activeFunders: (r) => (r.activeOrganizationNames ?? []).length || null,
          connectionStatus: (r) => r.connectionStatus ?? null,
          newsletter: (r) => NEWSLETTER_SORT[newsletterStatus(r)],
          enthusiasm: (r) => r.enthusiasm ?? null,
          owner: (r) =>
            r.ownerUserId
              ? (userNames.get(r.ownerUserId) ?? r.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [rows, ts.sort, regionNames, userNames, viewer],
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
    owners.length > 0 ||
    !!lifetimeGivingPresence ||
    !!lastGiftPresence ||
    !!openAsksPresence ||
    !!activeAffiliationPresence ||
    connectionStatusSel.length > 0 ||
    enthusiasmSel.length > 0 ||
    prioritySel.length > 0 ||
    regionIdsSel.length > 0 ||
    newsletterSel.length > 0;

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
    lifetimeGivingPresence: PresenceValue;
    lastGiftPresence: PresenceValue;
    openAsksPresence: PresenceValue;
    activeAffiliationPresence: PresenceValue;
    connectionStatusSel: string[];
    enthusiasmSel: string[];
    prioritySel: string[];
    regionIdsSel: string[];
    newsletterSel: string[];
    sort: SortState;
    columns: ColumnsState | null;
    filters: FiltersState | null;
  };
  const currentView: IndividualsView = {
    search,
    deceasedSel,
    capacityTiers,
    owners,
    lifetimeGivingPresence,
    lastGiftPresence,
    openAsksPresence,
    activeAffiliationPresence,
    connectionStatusSel,
    enthusiasmSel,
    prioritySel,
    regionIdsSel,
    newsletterSel,
    sort: ts.sort,
    columns: columnsState,
    filters: filtersState,
  };
  const clearAll = () => {
    setSearch("");
    setDeceasedSel([]);
    setCapacityTiers([]);
    setOwners([]);
    setLifetimeGivingPresence(undefined);
    setLastGiftPresence(undefined);
    setOpenAsksPresence(undefined);
    setActiveAffiliationPresence(undefined);
    setConnectionStatusSel([]);
    setEnthusiasmSel([]);
    setPrioritySel([]);
    setRegionIdsSel([]);
    setNewsletterSel([]);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
    selection.clear();
    // Clearing only resets filter values + sort; we deliberately leave
    // the user's column config and filter-chooser visibility alone since
    // they're presentation preferences set once and forgotten.
  };
  const viewsCtrl = useSavedViews<IndividualsView>({
    listKey: "individuals",
    current: currentView,
    apply: (s) => {
      setSearch(s.search ?? "");
      setDeceasedSel(s.deceasedSel ?? []);
      setCapacityTiers(s.capacityTiers ?? []);
      setOwners(s.owners ?? []);
      setLifetimeGivingPresence(s.lifetimeGivingPresence ?? undefined);
      setLastGiftPresence(s.lastGiftPresence ?? undefined);
      setOpenAsksPresence(s.openAsksPresence ?? undefined);
      setActiveAffiliationPresence(s.activeAffiliationPresence ?? undefined);
      setConnectionStatusSel(s.connectionStatusSel ?? []);
      setEnthusiasmSel(s.enthusiasmSel ?? []);
      setPrioritySel(s.prioritySel ?? []);
      setRegionIdsSel(s.regionIdsSel ?? []);
      setNewsletterSel(s.newsletterSel ?? []);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      // Backwards-compat: views saved before this feature have no
      // `columns` / `filters` field. Treat them as "defaults" so applying
      // doesn't accidentally hide anything.
      setColumnsState(s.columns ?? null);
      setFiltersState(s.filters ?? null);
      setPage(1);
      selection.clear();
    },
    isDefault: (s) =>
      !s.search &&
      (s.deceasedSel?.length ?? 0) === 0 &&
      (s.capacityTiers?.length ?? 0) === 0 &&
      (s.owners?.length ?? 0) === 0 &&
      !s.lifetimeGivingPresence &&
      !s.lastGiftPresence &&
      !s.openAsksPresence &&
      !s.activeAffiliationPresence &&
      (s.connectionStatusSel?.length ?? 0) === 0 &&
      (s.enthusiasmSel?.length ?? 0) === 0 &&
      (s.prioritySel?.length ?? 0) === 0 &&
      (s.regionIdsSel?.length ?? 0) === 0 &&
      (s.newsletterSel?.length ?? 0) === 0 &&
      (s.sort?.key ?? null) === null &&
      (s.columns ?? null) === null &&
      (s.filters ?? null) === null,
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
            aria-label="Search people by name"
            data-testid="input-search-people"
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
              setDeceasedSel([]);
              setCapacityTiers([]);
              setOwners([]);
              setLifetimeGivingPresence(undefined);
              setLastGiftPresence(undefined);
              setOpenAsksPresence(undefined);
              setActiveAffiliationPresence(undefined);
              setConnectionStatusSel([]);
              setEnthusiasmSel([]);
              setPrioritySel([]);
              setRegionIdsSel([]);
              setNewsletterSel([]);
              setPage(1);
              selection.clear();
            }}
          >
            Clear
          </Button>
        )}

        <div className="ml-auto flex items-end gap-2">
          <ShowArchivedToggle
            value={showArchived}
            onChange={(v) => {
              setShowArchived(v);
              setPage(1);
              selection.clear();
            }}
            testId="toggle-show-archived-people"
          />
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
        </div>
      </div>

      {viewMode === "kanban" ? (
        <EntityKanban
          rows={rows}
          isLoading={isLoading}
          isError={isError}
          error={error}
          truncated={kanbanTruncated}
          onMove={handlePersonMove}
          renderCard={(person, { hidden, isOverlay }) => (
            <DraggableCard id={person.id} hidden={hidden} isOverlay={isOverlay}>
              <Link
                href={`/individuals/${person.id}`}
                className="font-medium text-foreground hover:text-primary line-clamp-1 text-sm"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {canSeeIdentity(person, viewer) ? displayPersonName(person, viewer) : ANONYMOUS_LABEL}
              </Link>
              {person.currentHomeRegionId && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {regionNames.get(person.currentHomeRegionId) ?? person.currentHomeRegionId}
                </div>
              )}
            </DraggableCard>
          )}
        />
      ) : (
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
                      aria-label={`Select ${displayPersonName(p, viewer)}`}
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
      )}

      {viewMode === "list" && (
        <BulkActionBar
          count={selection.count}
          onEdit={() => setBulkOpen(true)}
          onMerge={() => setMergeOpen(true)}
          onArchive={() => setBulkArchiveOpen(true)}
          onClear={selection.clear}
          entityNoun="person"
        />
      )}
      <BulkArchiveDialog
        open={bulkArchiveOpen}
        onOpenChange={setBulkArchiveOpen}
        entityNoun="person"
        selectedIds={selection.selectedIds}
        invalidateKeys={[getListPeopleQueryKey()]}
        onConfirm={async () =>
          bulkArchiveMut.mutateAsync({ data: { ids: selection.selectedIds } })
        }
        onDone={(r) => selection.removeMany(r.succeededIds)}
      />
      {mergeOpen && !mergeLoading && mergeRecords.length >= 2 && (
        <MergeDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          entityNoun="person"
          records={mergeRecords}
          fields={mergeFields}
          recordLabel={mergeLabel}
          invalidateKeys={[getListPeopleQueryKey()]}
          onSubmit={async ({ primaryId, mergeIds: ids, overrides }) =>
            mergeMut.mutateAsync({ data: { primaryId, mergeIds: ids, overrides } })
          }
          onDone={() => selection.clear()}
        />
      )}
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
