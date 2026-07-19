import { useCallback, useMemo, useState, Fragment } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useBulkUpdateGiftsAndPayments,
  useBulkArchiveGiftsAndPayments,
  useArchiveGiftOrPayment,
  useUnarchiveGiftOrPayment,
  useUpdateGiftOrPayment,
  getGetGiftOrPaymentQueryOptions,
  getGetGiftOrPaymentQueryKey,
  ListGiftsAndPaymentsWorklist,
  ListGiftsAndPaymentsRestrictionLabelsItem,
  type ListGiftsAndPaymentsParams,
  type GiftType,
  type GiftPaymentMethod,
  type GiftOrPayment,
  type GiftOrPaymentDetail,
  useListEntities,
  getListEntitiesQueryKey,
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useSavedViews } from "@/hooks/use-saved-views";
import { Badge } from "@/components/ui/badge";
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
import {
  MergeGiftsDialog,
  MergeIntoPledgeDialog,
} from "@/components/gift-merge-dialogs";
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
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X, ChevronDown, ChevronRight } from "lucide-react";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { FiscalYearMultiSelect } from "@/components/fiscal-year-multi-select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { PageJumper } from "@/components/page-jumper";
import { DonorCell } from "@/components/donor-cell";
import { GiftFormDialog } from "@/components/gift-form-dialog";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";

const TYPES: GiftType[] = [
  "standard_gift",
  "pledge_payment",
  "directed_gift",
  "loan_fund_investment",
  "matching_gift",
  "reimbursement",
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

// Human label for the donor-lifecycle worklist banner.
const GIFT_WORKLIST_LABELS: Record<ListGiftsAndPaymentsWorklist, string> = {
  missing_allocations: "Gifts missing allocations",
};

const NONE = "__none__";
type GiftDraft = {
  type: string;
  paymentMethod: string;
};

type InlineCtx = {
  editingId: string | null;
  draft: GiftDraft | null;
  isEditing: (id: string) => boolean;
  patch: (partial: Partial<GiftDraft>) => void;
  save: () => void;
  cancel: () => void;
  saving: boolean;
};

type ColCtx = {
  userNames: Map<string, string>;
  entityNameById: Map<string, string>;
  isAdmin: boolean;
  inline: InlineCtx;
  onOpen: (g: GiftOrPayment) => void;
  onStartEdit: (g: GiftOrPayment) => void;
  onArchive: (g: GiftOrPayment) => void;
  onUnarchive: (g: GiftOrPayment) => void;
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
          <span className="inline-flex items-center gap-1.5">
            {g.name ?? `Gift ${g.id}`}
            {g.donorboxBacked ? (
              <Badge
                variant="outline"
                className="shrink-0 border-teal-300 bg-teal-50 px-1.5 py-0 text-[10px] font-medium text-teal-700"
                title="Backed by a Donorbox donation"
                data-testid={`badge-donorbox-${g.id}`}
              >
                Donorbox
              </Badge>
            ) : null}
          </span>
        </Link>
      ),
    },
    {
      key: "donor",
      label: "Donor",
      cell: (g) => (
        <DonorCell
          organizationId={g.organizationId}
          organizationName={g.organizationName}
          organizationPriority={g.organizationPriority}
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
      cell: (g) =>
        ctx.inline.isEditing(g.id) ? (
          <Select
            value={ctx.inline.draft?.type ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ type: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Type"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-type-gift-${g.id}`}
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
          formatEnum(g.type)
        ),
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
      cell: (g) =>
        ctx.inline.isEditing(g.id) ? (
          <Select
            value={ctx.inline.draft?.paymentMethod ?? NONE}
            onValueChange={(v) => ctx.inline.patch({ paymentMethod: v })}
          >
            <SelectTrigger
              className="h-8"
              aria-label="Payment method"
              onClick={(e) => e.stopPropagation()}
              data-testid={`select-inline-paymentMethod-gift-${g.id}`}
            >
              <SelectValue placeholder="Payment method" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {PAYMENT_METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {formatEnum(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          formatEnum(g.paymentMethod)
        ),
    },
    {
      key: "thankYouSentAt",
      label: "Thank-you sent",
      defaultVisible: false,
      cell: (g) => formatDateShort(g.thankYouSentAt),
    },
    {
      key: "restrictionLabel",
      label: "Restriction",
      defaultVisible: false,
      tdClassName: "text-sm",
      cell: (g) => g.restrictionLabel ?? "—",
    },
    {
      key: "purposeVerbatims",
      label: "Purpose verbatim",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground max-w-[300px] whitespace-normal",
      cell: (g) => {
        const vals = g.purposeVerbatims ?? [];
        return vals.length === 0 ? "—" : vals.join("; ");
      },
    },
    {
      key: "regionalRestrictionTypes",
      label: "Regional restriction",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground",
      cell: (g) => {
        const vals = g.regionalRestrictionTypes ?? [];
        return vals.length === 0 ? "—" : vals.map(formatEnum).join(", ");
      },
    },
    {
      key: "usageRestrictionTypes",
      label: "Usage restriction",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground",
      cell: (g) => {
        const vals = g.usageRestrictionTypes ?? [];
        return vals.length === 0 ? "—" : vals.map(formatEnum).join(", ");
      },
    },
    {
      key: "timeRestrictionTypes",
      label: "Time restriction",
      defaultVisible: false,
      sortable: false,
      tdClassName: "text-xs text-muted-foreground",
      cell: (g) => {
        const vals = g.timeRestrictionTypes ?? [];
        return vals.length === 0 ? "—" : vals.map(formatEnum).join(", ");
      },
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
      cell: (g) =>
        ctx.inline.isEditing(g.id) ? (
          <InlineRowSaveActions
            onSave={ctx.inline.save}
            onCancel={ctx.inline.cancel}
            saving={ctx.inline.saving}
            testIdPrefix={`gift-${g.id}`}
          />
        ) : (
          <RowActionIcons
            entityLabel={g.name ?? `Gift ${g.id}`}
            testIdPrefix={`gift-${g.id}`}
            disabled={ctx.inline.editingId !== null}
            archived={!!g.archivedAt}
            onOpen={() => ctx.onOpen(g)}
            onEdit={() => ctx.onStartEdit(g)}
            onArchive={
              g.archivedAt
                ? ctx.isAdmin
                  ? () => ctx.onUnarchive(g)
                  : undefined
                : () => ctx.onArchive(g)
            }
          />
        ),
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
  const [awaitingEvidence, setAwaitingEvidence] = usePersistedState<boolean>("wf.list.gifts.f.awaitingEvidence", false);
  const [dateReceivedPresence, setDateReceivedPresence] = usePersistedState<PresenceValue>("wf.list.gifts.f.dateReceived", undefined);
  const [purposeVerbatimPresence, setPurposeVerbatimPresence] = usePersistedState<PresenceValue>("wf.list.gifts.f.purposeVerbatim", undefined);
  const [restrictionLabels, setRestrictionLabels] = usePersistedState<string[]>("wf.list.gifts.f.restrictionLabels", []);
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
  const [, navigate] = useLocation();
  // Donor-lifecycle worklist preset, read from the URL (?worklist=...). Set by
  // the dashboard worklist tiles. Only values valid for this endpoint are
  // honored; URL-driven only (not a saved-view filter), with a dismissible
  // banner when active.
  const urlSearch = useSearch();
  const rawWorklist = new URLSearchParams(urlSearch).get("worklist");
  const worklist: ListGiftsAndPaymentsWorklist | undefined =
    rawWorklist &&
    (Object.values(ListGiftsAndPaymentsWorklist) as string[]).includes(rawWorklist)
      ? (rawWorklist as ListGiftsAndPaymentsWorklist)
      : undefined;
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = usePersistedState<boolean>(
    "wf.list.gifts.showArchived",
    false,
  );
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const [mergeGiftOpen, setMergeGiftOpen] = useState(false);
  const [mergePledgeOpen, setMergePledgeOpen] = useState(false);
  const bulkMut = useBulkUpdateGiftsAndPayments();
  const bulkArchiveMut = useBulkArchiveGiftsAndPayments();
  const archiveMut = useArchiveGiftOrPayment();
  const unarchiveMut = useUnarchiveGiftOrPayment();
  const updateGift = useUpdateGiftOrPayment();

  // Global entity filter (header dropdown). Forwarded to the server so the
  // gifts list is scoped to gifts with at least one allocation on the
  // selected entities. Mirrors the dashboard and opportunities pages.
  const { selected: globalEntityIds } = useEntityFilter();

  const ts = useTableState("gifts");
  const sortActive = ts.sort.key !== null;
  const params: ListGiftsAndPaymentsParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
    ...(isAdmin && showArchived ? { includeArchived: true } : {}),
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(worklist ? { worklist } : {}),
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
    ...(awaitingEvidence ? { awaitingEvidence: true } : {}),
    ...(dateReceivedPresence ? { dateReceivedPresence } : {}),
    ...(purposeVerbatimPresence ? { purposeVerbatimPresence } : {}),
    ...(restrictionLabels.length > 0 ? { restrictionLabels: [...restrictionLabels].sort() as ListGiftsAndPaymentsRestrictionLabelsItem[] } : {}),
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

  const refreshList = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: getListGiftsAndPaymentsQueryKey(),
      }),
    [queryClient],
  );

  const inlineEdit = useInlineRowEdit<GiftOrPayment, GiftDraft>({
    getId: (g) => g.id,
    toDraft: (g) => ({
      type: g.type ?? NONE,
      paymentMethod: g.paymentMethod ?? NONE,
    }),
    onSave: async (id, d) => {
      await updateGift.mutateAsync({
        id,
        data: {
          type: d.type === NONE ? null : (d.type as GiftType),
          paymentMethod:
            d.paymentMethod === NONE
              ? null
              : (d.paymentMethod as GiftPaymentMethod),
        },
      });
      await refreshList();
      toast({ title: "Gift updated" });
    },
  });

  const archiveGift = (g: GiftOrPayment) =>
    archiveMut.mutate(
      { id: g.id },
      {
        onSuccess: async () => {
          await refreshList();
          selection.removeMany([g.id]);
          toast({ title: "Gift archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const unarchiveGift = (g: GiftOrPayment) =>
    unarchiveMut.mutate(
      { id: g.id },
      {
        onSuccess: async () => {
          await refreshList();
          toast({ title: "Gift unarchived" });
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
        onOpen: (g) => navigate(`/gifts/${g.id}`),
        onStartEdit: (g) => inlineEdit.start(g),
        onArchive: archiveGift,
        onUnarchive: unarchiveGift,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userNames, entityNameById, isAdmin, inlineEdit, navigate],
  );
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length + 2;

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
      {
        // Edge case B4: CRM-first gifts logged before any funding evidence
        // arrived. Save it as a view ("Awaiting evidence") to get a queue.
        key: "awaitingEvidence",
        label: "Awaiting evidence",
        defaultVisible: false,
        active: awaitingEvidence,
        clear: () => { setAwaitingEvidence(false); setPage(1); selection.clear(); },
        render: () => (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Awaiting evidence
            </label>
            <div className="flex h-9 items-center gap-2">
              <Checkbox
                id="filter-awaiting-evidence"
                checked={awaitingEvidence}
                onCheckedChange={(c) => { setAwaitingEvidence(c === true); setPage(1); selection.clear(); }}
                data-testid="filter-awaiting-evidence"
              />
              <label htmlFor="filter-awaiting-evidence" className="text-sm">
                Only awaiting evidence
              </label>
            </div>
          </div>
        ),
      },
      {
        key: "dateReceived",
        label: "Date received",
        defaultVisible: false,
        active: !!dateReceivedPresence,
        clear: () => { setDateReceivedPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Date received"
            value={dateReceivedPresence}
            onChange={(v) => { setDateReceivedPresence(v); setPage(1); selection.clear(); }}
            testId="filter-date-received"
          />
        ),
      },
      {
        key: "purposeVerbatim",
        label: "Purpose (verbatim)",
        defaultVisible: false,
        active: !!purposeVerbatimPresence,
        clear: () => { setPurposeVerbatimPresence(undefined); setPage(1); selection.clear(); },
        render: () => (
          <PresenceFilter
            label="Purpose (verbatim)"
            value={purposeVerbatimPresence}
            onChange={(v) => { setPurposeVerbatimPresence(v); setPage(1); selection.clear(); }}
            testId="filter-purpose-verbatim"
          />
        ),
      },
      {
        key: "restrictionLabels",
        label: "Restriction",
        defaultVisible: false,
        active: restrictionLabels.length > 0,
        clear: () => { setRestrictionLabels([]); setPage(1); selection.clear(); },
        render: () => (
          <MultiFilterSelect
            label="Restriction"
            selected={restrictionLabels}
            onChange={(v) => { setRestrictionLabels(v); setPage(1); selection.clear(); }}
            options={[
              { value: "unrestricted", label: "Unrestricted" },
              { value: "purpose", label: "Purpose restricted" },
              { value: "time", label: "Time restricted" },
              { value: "both", label: "Purpose + time restricted" },
            ]}
            testId="select-restriction-labels"
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [types, owners, fiscalYears, entitiesPresence, usagesPresence, grantYearsPresence, paymentMethods, thankYouPresence, awaitingEvidence, dateReceivedPresence, purposeVerbatimPresence, restrictionLabels],
  );
  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
  );

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Fetch full records for the merge dialogs only while one is open. Selected
  // ids may span pages/filters, so we resolve each by id rather than reuse
  // the current page's rows.
  const mergeOpen = mergeGiftOpen || mergePledgeOpen;
  const mergeIds = mergeOpen ? selection.selectedIds : [];
  const mergeQueries = useQueries({
    queries: mergeIds.map((id) =>
      getGetGiftOrPaymentQueryOptions(id, {
        query: {
          enabled: mergeOpen,
          staleTime: 30_000,
          queryKey: getGetGiftOrPaymentQueryKey(id),
        },
      }),
    ),
  });
  const mergeRecords = useMemo<GiftOrPaymentDetail[]>(
    () =>
      mergeQueries
        .map((q) => q.data)
        .filter((d): d is GiftOrPaymentDetail => !!d),
    [mergeQueries],
  );
  // The dialogs must operate on EVERY selected gift — never a partially loaded
  // subset. Surface the expected count + load/error state so they can block
  // submit until all selected records resolve.
  const mergeExpectedCount = mergeIds.length;
  const mergeLoadError = mergeQueries.some((q) => q.isError);

  // Expand/collapse: fetch the gift detail for expanded rows to show allocations.
  const [expandedGiftIds, setExpandedGiftIds] = useState<Set<string>>(new Set());
  const toggleExpandGift = (id: string) =>
    setExpandedGiftIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const expandGiftQueries = useQueries({
    queries: [...expandedGiftIds].map((id) =>
      getGetGiftOrPaymentQueryOptions(id, {
        query: { enabled: true, staleTime: 60_000, queryKey: getGetGiftOrPaymentQueryKey(id) },
      }),
    ),
  });
  const expandedGiftDetailsById = useMemo(() => {
    const map = new Map<string, GiftOrPaymentDetail>();
    for (const q of expandGiftQueries) {
      if (q.data) map.set(q.data.id, q.data);
    }
    return map;
  }, [expandGiftQueries]);

  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => (r.name ?? "").toLowerCase(),
          donor: (r) =>
            (r.organizationName ?? r.householdName ?? r.individualGiverPersonName ?? "").toLowerCase(),
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
    awaitingEvidence: boolean;
    dateReceivedPresence: PresenceValue;
    purposeVerbatimPresence: PresenceValue;
    restrictionLabels: string[];
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
    awaitingEvidence,
    dateReceivedPresence,
    purposeVerbatimPresence,
    restrictionLabels,
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
    setAwaitingEvidence(false);
    setDateReceivedPresence(undefined);
    setPurposeVerbatimPresence(undefined);
    setRestrictionLabels([]);
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
      setAwaitingEvidence(s.awaitingEvidence ?? false);
      setDateReceivedPresence(s.dateReceivedPresence ?? undefined);
      setPurposeVerbatimPresence(s.purposeVerbatimPresence ?? undefined);
      setRestrictionLabels(s.restrictionLabels ?? []);
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
      !s.awaitingEvidence &&
      !s.dateReceivedPresence &&
      !s.purposeVerbatimPresence &&
      (s.restrictionLabels?.length ?? 0) === 0 &&
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
    !!thankYouPresence ||
    awaitingEvidence ||
    !!dateReceivedPresence ||
    !!purposeVerbatimPresence ||
    restrictionLabels.length > 0;

  return (
    <div className="space-y-6">
      <ListPageHeader
        title="Gifts & payments"
        subtitle={isLoading ? <Skeleton className="h-4 w-20" /> : `${total.toLocaleString()} total`}
        addAction={<GiftFormDialog />}
        controls={
          <>
            <ShowArchivedToggle
              value={showArchived}
              onChange={(v) => {
                setShowArchived(v);
                setPage(1);
                selection.clear();
              }}
              testId="toggle-show-archived-gifts"
            />
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
            Showing worklist: <strong>{GIFT_WORKLIST_LABELS[worklist]}</strong>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-amber-900 hover:bg-amber-100"
            onClick={() => navigate("/gifts")}
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
              aria-label="Search gifts by name"
              data-testid="input-search-gifts"
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
                data-testid="button-clear-search-gifts"
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
              setTypes([]);
              setOwners([]);
              setFiscalYears([]);
              setEntitiesPresence(undefined);
              setUsagesPresence(undefined);
              setGrantYearsPresence(undefined);
              setPaymentMethods([]);
              setThankYouPresence(undefined);
              setAwaitingEvidence(false);
              setDateReceivedPresence(undefined);
              setPurposeVerbatimPresence(undefined);
              setRestrictionLabels([]);
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
              <TableHead className="w-6 px-1" />
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
              <SkeletonRows cols={colSpan} />
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
                <Fragment key={g.id}>
                  <TableRow className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-gift-${g.id}`}>
                    <TableCell className="w-6 px-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 p-0 text-muted-foreground"
                        onClick={() => toggleExpandGift(g.id)}
                        aria-label={expandedGiftIds.has(g.id) ? "Collapse allocations" : "Expand allocations"}
                        tabIndex={-1}
                      >
                        {expandedGiftIds.has(g.id)
                          ? <ChevronDown className="h-3 w-3" />
                          : <ChevronRight className="h-3 w-3" />
                        }
                      </Button>
                    </TableCell>
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selection.isSelected(g.id)}
                        onCheckedChange={() => selection.toggle(g.id)}
                        aria-label={`Select ${g.name ?? g.id}`}
                        data-testid={`checkbox-select-${g.id}`}
                      />
                    </TableCell>
                    {visibleCols.map((c) => (
                      <TableCell
                        key={c.key}
                        className={c.tdClassName}
                        onClick={c.key !== "name" && c.key !== "actions" && !inlineEdit.isEditing(g.id) && !g.archivedAt ? () => inlineEdit.start(g) : undefined}
                        style={c.key !== "name" && c.key !== "actions" && !inlineEdit.isEditing(g.id) && !g.archivedAt ? { cursor: "text" } : undefined}
                      >
                        {c.cell(g)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expandedGiftIds.has(g.id) && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell />
                      <TableCell colSpan={visibleCols.length} className="py-2">
                        {expandedGiftDetailsById.has(g.id) ? (
                          (expandedGiftDetailsById.get(g.id)!.allocations ?? []).length === 0 ? (
                            <span className="text-xs text-muted-foreground italic">No allocations</span>
                          ) : (
                            <table className="text-xs text-muted-foreground w-full">
                              <thead>
                                <tr className="text-left">
                                  <th className="font-medium pb-1 pr-3">Entity</th>
                                  <th className="font-medium pb-1 pr-3">FY</th>
                                  <th className="font-medium pb-1 pr-3 text-right">Amount</th>
                                  <th className="font-medium pb-1 pr-3">Usage</th>
                                  <th className="font-medium pb-1">Purpose (verbatim)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(expandedGiftDetailsById.get(g.id)!.allocations ?? []).map((a, i) => (
                                  <tr key={i}>
                                    <td className="pr-3 pb-0.5">{entityNameById.get(a.entityId ?? "") ?? "—"}</td>
                                    <td className="pr-3 pb-0.5">{a.grantYear?.toUpperCase() ?? "—"}</td>
                                    <td className="pr-3 pb-0.5 text-right tabular-nums">{a.subAmount != null ? `$${Number(a.subAmount).toLocaleString()}` : "—"}</td>
                                    <td className="pr-3 pb-0.5">{a.displayUsage ?? "—"}</td>
                                    <td className="pb-0.5 max-w-[220px] truncate">{a.purposeVerbatim ?? "—"}</td>
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

      <BulkActionBar
        count={selection.count}
        onEdit={() => setBulkOpen(true)}
        onArchive={() => setBulkArchiveOpen(true)}
        onClear={selection.clear}
        entityNoun="gift"
        extraActions={
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMergeGiftOpen(true)}
              data-testid="button-bulk-merge-gift"
            >
              Merge into one gift
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMergePledgeOpen(true)}
              data-testid="button-bulk-merge-pledge"
            >
              Merge into one pledge
            </Button>
          </>
        }
      />
      <BulkArchiveDialog
        open={bulkArchiveOpen}
        onOpenChange={setBulkArchiveOpen}
        entityNoun="gift"
        selectedIds={selection.selectedIds}
        invalidateKeys={[getListGiftsAndPaymentsQueryKey()]}
        onConfirm={async () =>
          bulkArchiveMut.mutateAsync({ data: { ids: selection.selectedIds } })
        }
        onDone={(r) => selection.removeMany(r.succeededIds)}
      />
      <MergeGiftsDialog
        open={mergeGiftOpen}
        onOpenChange={setMergeGiftOpen}
        gifts={mergeRecords}
        expectedCount={mergeExpectedCount}
        loadError={mergeLoadError}
        onDone={() => selection.clear()}
      />
      <MergeIntoPledgeDialog
        open={mergePledgeOpen}
        onOpenChange={setMergePledgeOpen}
        gifts={mergeRecords}
        expectedCount={mergeExpectedCount}
        loadError={mergeLoadError}
        onDone={() => selection.clear()}
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
