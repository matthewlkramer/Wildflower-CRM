import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListOpportunitiesAndPledges,
  useArchiveOpportunityOrPledge,
  useUpdateOpportunityOrPledge,
  useBulkUpdateOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityOrPledge,
  type OpportunityLossType,
  type OpportunityStage,
  type OpportunityType,
  type UpdateOpportunityOrPledgeBody,
} from "@workspace/api-client-react";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  resolveColumns,
  type ColumnDef,
  type ColumnsState,
} from "@/lib/columns";
import {
  resolveFilters,
  type FilterDef,
  type FiltersState,
} from "@/lib/filters";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useRowSelection } from "@/hooks/use-row-selection";
import { useDebounce } from "@/hooks/use-debounce";
import { useSaveRunner } from "@/components/inline-edit";
import { useToast } from "@/hooks/use-toast";
import { useEntityFilter } from "@/lib/entity-filter-context";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import { ColumnsMenu } from "@/components/columns-menu";
import { FiltersMenu } from "@/components/filters-menu";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { OPPORTUNITIES_BULK_FIELDS } from "@/lib/bulk-fields";
import {
  RowActionIcons,
  InlineRowSaveActions,
} from "@/components/row-action-icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SkeletonRows } from "@/components/ui/skeleton";
import { DonorCell } from "@/components/donor-cell";
import { CircleX, PauseCircle, X } from "lucide-react";

const FETCH_LIMIT = 1000;
const STAGES: OpportunityStage[] = [
  "cold_lead",
  "warm_lead",
  "in_conversation",
  "convince",
  "probable_renewal",
  "verbal_confirmation",
  "complete",
];
const TYPES: OpportunityType[] = [
  "solicitation",
  "renewal",
  "open_application",
];

function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function buildColumns(
  userNames: Map<string, string>,
): ColumnDef<OpportunityOrPledge>[] {
  return [
    {
      key: "applicationDeadline",
      label: "Application deadline",
      required: true,
      cell: (o) => formatDateShort(o.applicationDeadline),
    },
    {
      key: "projectedClose",
      label: "Projected close",
      cell: (o) => formatDateShort(o.projectedCloseDate),
    },
    {
      key: "name",
      label: "Name",
      required: true,
      tdClassName: "font-medium",
      cell: (o) => (
        <Link href={`/opportunities/${o.id}`} className="block w-full">
          {o.name ?? `Untitled ${o.id}`}
        </Link>
      ),
    },
    {
      key: "funder",
      label: "Funder",
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
      key: "primaryContact",
      label: "Primary contact",
      cell: (o) =>
        o.primaryContactPersonId ? (
          <Link
            href={`/individuals/${o.primaryContactPersonId}`}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {o.primaryContactPersonName ?? o.primaryContactPersonId}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "type",
      label: "Opportunity type",
      cell: (o) => formatEnum(o.type),
    },
    {
      key: "stage",
      label: "Stage",
      cell: (o) => formatEnum(o.stage),
    },
    {
      key: "ask",
      label: "Ask",
      align: "right",
      tdClassName: "text-right tabular-nums",
      cell: (o) => formatCurrency(o.askAmount),
    },
    {
      key: "owner",
      label: "Owner",
      defaultVisible: false,
      cell: (o) =>
        o.ownerUserId ? (userNames.get(o.ownerUserId) ?? o.ownerUserId) : "—",
    },
    {
      key: "actions",
      label: "",
      required: true,
      alwaysLast: true,
      sortable: false,
      align: "right",
      thClassName: "w-[330px]",
      tdClassName: "text-right",
      cell: () => null,
    },
  ];
}

export default function GrantsCalendar() {
  const persistNs = "wf.list.grants-calendar";
  const [search, setSearch] = usePersistedState<string>(
    `${persistNs}.search`,
    "",
  );
  const [types, setTypes] = usePersistedState<string[]>(
    `${persistNs}.types`,
    [],
  );
  const [stages, setStages] = usePersistedState<string[]>(
    `${persistNs}.stages`,
    [],
  );
  const [owners, setOwners] = usePersistedState<string[]>(
    `${persistNs}.owners`,
    [],
  );
  const [columnsState, setColumnsState] =
    usePersistedState<ColumnsState | null>(`${persistNs}.columns`, null);
  const [filtersState, setFiltersState] =
    usePersistedState<FiltersState | null>(`${persistNs}.filters`, null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const debouncedSearch = useDebounce(search, 250);
  const selection = useRowSelection();
  const { selected: globalEntityIds } = useEntityFilter();
  const userNames = useUserNameMap();
  const queryParams: ListOpportunitiesAndPledgesParams = {
    status: ["open"],
    limit: FETCH_LIMIT,
    page: 1,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(types.length > 0
      ? { type: [...types].sort() as OpportunityType[] }
      : {}),
    ...(stages.length > 0
      ? { stage: [...stages].sort() as OpportunityStage[] }
      : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(globalEntityIds.length > 0
      ? { entityId: [...globalEntityIds].sort() }
      : {}),
  };
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(
    queryParams,
    {
      query: { queryKey: getListOpportunitiesAndPledgesQueryKey(queryParams) },
    },
  );

  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const archiveMut = useArchiveOpportunityOrPledge();
  const bulkMut = useBulkUpdateOpportunitiesAndPledges();
  const update = useUpdateOpportunityOrPledge({
    mutation: {
      onError: (err: unknown) =>
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListOpportunitiesAndPledgesQueryKey(),
    });

  const saveDates = async (id: string, body: UpdateOpportunityOrPledgeBody) => {
    await update.mutateAsync({ id, data: body });
    await invalidate();
    toast({ title: "Dates updated" });
  };

  const resolveOpp = async (
    o: OpportunityOrPledge,
    lossType: OpportunityLossType,
  ) => {
    const body: UpdateOpportunityOrPledgeBody = { lossType };
    if (!o.actualCompletionDate) body.actualCompletionDate = todayInChicago();
    await update.mutateAsync({ id: o.id, data: body });
    await invalidate();
    selection.removeMany([o.id]);
    toast({ title: lossType === "lost" ? "Marked lost" : "Marked dormant" });
  };

  const archiveOpportunity = (o: OpportunityOrPledge) =>
    archiveMut.mutate(
      { id: o.id },
      {
        onSuccess: async () => {
          await invalidate();
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

  const filterRegistry = useMemo<FilterDef[]>(
    () => [
      {
        key: "type",
        label: "Opportunity type",
        active: types.length > 0,
        clear: () => {
          setTypes([]);
          selection.clear();
        },
        render: () => (
          <MultiFilterSelect
            label="Opportunity type"
            selected={types}
            onChange={(next) => {
              setTypes(next);
              selection.clear();
            }}
            options={TYPES}
            includeBlank
            testId="select-calendar-type"
          />
        ),
      },
      {
        key: "stage",
        label: "Stage",
        active: stages.length > 0,
        clear: () => {
          setStages([]);
          selection.clear();
        },
        render: () => (
          <MultiFilterSelect
            label="Stage"
            selected={stages}
            onChange={(next) => {
              setStages(next);
              selection.clear();
            }}
            options={STAGES}
            includeBlank
            testId="select-calendar-stage"
          />
        ),
      },
      {
        key: "owner",
        label: "Owner",
        active: owners.length > 0,
        clear: () => {
          setOwners([]);
          selection.clear();
        },
        render: () => (
          <OwnerMultiFilter
            selected={owners}
            onChange={(next) => {
              setOwners(next);
              selection.clear();
            }}
            testId="select-calendar-owner"
          />
        ),
      },
    ],
    [owners, selection, setOwners, setStages, setTypes, stages, types],
  );
  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
  );
  const columnRegistry = useMemo(() => buildColumns(userNames), [userNames]);
  const visibleCols = useMemo(
    () => resolveColumns(columnRegistry, columnsState),
    [columnRegistry, columnsState],
  );

  const ts = useTableState(persistNs, {
    key: "applicationDeadline",
    dir: "asc",
  });
  const STAGE_ORDER: Record<string, number> = {
    cold_lead: 1,
    warm_lead: 2,
    in_conversation: 3,
    convince: 4,
    probable_renewal: 5,
    verbal_confirmation: 6,
    complete: 7,
    conditional_commitment: 6,
    written_commitment: 6,
    cash_in: 7,
  };
  const today = todayInChicago();
  const upcoming = useMemo(
    () =>
      (data?.data ?? [])
        .filter((o) => Boolean(o.applicationDeadline ?? o.projectedCloseDate))
        .sort((a, b) =>
          (a.applicationDeadline ?? a.projectedCloseDate ?? "").localeCompare(
            b.applicationDeadline ?? b.projectedCloseDate ?? "",
          ),
        ),
    [data],
  );
  const sortedUpcoming = useMemo(
    () =>
      sortRows(
        upcoming,
        {
          applicationDeadline: (o) => o.applicationDeadline ?? null,
          projectedClose: (o) => o.projectedCloseDate ?? null,
          name: (o) => (o.name ?? "").toLowerCase(),
          funder: (o) =>
            (
              o.organizationName ??
              o.householdName ??
              o.individualGiverPersonName ??
              ""
            ).toLowerCase(),
          primaryContact: (o) =>
            o.primaryContactPersonName?.toLowerCase() ?? null,
          type: (o) => o.type ?? null,
          stage: (o) => (o.stage ? (STAGE_ORDER[o.stage] ?? 0) : null),
          ask: (o) => (o.askAmount != null ? Number(o.askAmount) : null),
          owner: (o) =>
            o.ownerUserId
              ? (userNames.get(o.ownerUserId) ?? o.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [ts.sort, upcoming, userNames],
  );
  const hasActiveFilters = Boolean(
    search || types.length || stages.length || owners.length,
  );
  const colSpan = visibleCols.length + 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Application/close deadlines
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Open opportunities with an application deadline or projected close
            date. Overdue items remain visible until they are resolved.
            {data && data.pagination.total > FETCH_LIMIT ? (
              <span>
                {" "}
                Showing the first {FETCH_LIMIT} of{" "}
                {data.pagination.total.toLocaleString()}.
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <FiltersMenu
            registry={filterRegistry}
            state={filtersState}
            onChange={setFiltersState}
          />
          <ColumnsMenu
            registry={columnRegistry}
            state={columnsState}
            onChange={setColumnsState}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[260px] grow">
          <Input
            placeholder="Search opportunities…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              selection.clear();
            }}
            aria-label="Search application and close deadlines"
            className="pr-8"
          />
          {search ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2"
              onClick={() => {
                setSearch("");
                selection.clear();
              }}
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
        {visibleFilters.map((filter) => (
          <div key={filter.key}>{filter.render()}</div>
        ))}
        {hasActiveFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setTypes([]);
              setStages([]);
              setOwners([]);
              selection.clear();
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={
                    sortedUpcoming.length > 0 &&
                    sortedUpcoming.every((row) => selection.isSelected(row.id))
                  }
                  onCheckedChange={() =>
                    selection.toggleVisible(sortedUpcoming.map((row) => row.id))
                  }
                  aria-label="Select all deadlines"
                  data-testid="checkbox-select-all-grant-deadlines"
                />
              </TableHead>
              {visibleCols.map((column) => (
                <SortableTH
                  key={column.key}
                  colKey={column.sortKey ?? column.key}
                  sortable={column.sortable}
                  align={column.align}
                  className={column.thClassName}
                  {...ts}
                >
                  {column.header ?? column.label}
                </SortableTH>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={colSpan} />
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={colSpan}
                  className="text-center h-24 text-destructive"
                >
                  {error instanceof Error
                    ? error.message
                    : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : sortedUpcoming.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={colSpan}
                  className="text-center h-24 text-muted-foreground"
                >
                  No open opportunities with an application deadline or
                  projected close date.
                </TableCell>
              </TableRow>
            ) : (
              sortedUpcoming.map((o) => (
                <CalendarRow
                  key={o.id}
                  o={o}
                  today={today}
                  columns={visibleCols}
                  selected={selection.isSelected(o.id)}
                  onSelect={() => selection.toggle(o.id)}
                  onOpen={() => navigate(`/opportunities/${o.id}`)}
                  onArchive={() => archiveOpportunity(o)}
                  onSaveDates={saveDates}
                  onResolve={resolveOpp}
                />
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
        entityPlural="opportunities"
      />
      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        entityNoun="opportunity"
        selectedIds={selection.selectedIds}
        fields={OPPORTUNITIES_BULK_FIELDS}
        invalidateKeys={[getListOpportunitiesAndPledgesQueryKey()]}
        onSubmit={(patch) =>
          bulkMut.mutateAsync({ data: { ids: selection.selectedIds, patch } })
        }
        onDone={(result) => selection.removeMany(result.succeededIds)}
      />
    </div>
  );
}

function DateCell({
  date,
  overdue,
}: {
  date: string | null | undefined;
  overdue: boolean;
}) {
  return (
    <span className={overdue ? "text-destructive font-medium" : undefined}>
      {formatDateShort(date)}
      {overdue ? (
        <Badge variant="destructive" className="ml-2 align-middle">
          Overdue
        </Badge>
      ) : null}
    </span>
  );
}

function CalendarRow({
  o,
  today,
  columns,
  selected,
  onSelect,
  onOpen,
  onArchive,
  onSaveDates,
  onResolve,
}: {
  o: OpportunityOrPledge;
  today: string;
  columns: ColumnDef<OpportunityOrPledge>[];
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onArchive: () => void;
  onSaveDates: (
    id: string,
    body: UpdateOpportunityOrPledgeBody,
  ) => Promise<void>;
  onResolve: (
    o: OpportunityOrPledge,
    lossType: OpportunityLossType,
  ) => Promise<void>;
}) {
  const [editingDates, setEditingDates] = useState(false);
  const [appDraft, setAppDraft] = useState("");
  const [closeDraft, setCloseDraft] = useState("");
  const [confirmLoss, setConfirmLoss] = useState<OpportunityLossType | null>(
    null,
  );
  const { busy, run } = useSaveRunner();
  const label = o.name ?? `Opportunity ${o.id}`;
  const drivingIsApp = Boolean(o.applicationDeadline);
  const drivingDate = o.applicationDeadline ?? o.projectedCloseDate ?? "";
  const overdue = Boolean(drivingDate) && drivingDate < today;

  const startEditDates = () => {
    setAppDraft(o.applicationDeadline ?? "");
    setCloseDraft(o.projectedCloseDate ?? "");
    setEditingDates(true);
  };

  const saveDates = () => {
    const appNext = appDraft.trim().length === 0 ? null : appDraft;
    const closeNext = closeDraft.trim().length === 0 ? null : closeDraft;
    if (
      appNext === (o.applicationDeadline ?? null) &&
      closeNext === (o.projectedCloseDate ?? null)
    ) {
      setEditingDates(false);
      return;
    }
    run(
      () =>
        onSaveDates(o.id, {
          applicationDeadline: appNext,
          projectedCloseDate: closeNext,
        }),
      () => setEditingDates(false),
    );
  };

  const confirmResolve = () => {
    if (!confirmLoss) return;
    const lossType = confirmLoss;
    run(
      () => onResolve(o, lossType),
      () => setConfirmLoss(null),
    );
  };

  const renderColumn = (column: ColumnDef<OpportunityOrPledge>) => {
    if (column.key === "applicationDeadline") {
      return editingDates ? (
        <Input
          type="date"
          value={appDraft}
          onChange={(event) => setAppDraft(event.target.value)}
          aria-label="Application deadline"
          disabled={busy}
          className="h-8"
        />
      ) : (
        <DateCell
          date={o.applicationDeadline}
          overdue={overdue && drivingIsApp}
        />
      );
    }
    if (column.key === "projectedClose") {
      return editingDates ? (
        <Input
          type="date"
          value={closeDraft}
          onChange={(event) => setCloseDraft(event.target.value)}
          aria-label="Projected close"
          disabled={busy}
          className="h-8"
        />
      ) : (
        <DateCell
          date={o.projectedCloseDate}
          overdue={overdue && !drivingIsApp}
        />
      );
    }
    if (column.key === "actions") {
      return editingDates ? (
        <InlineRowSaveActions
          onSave={saveDates}
          onCancel={() => setEditingDates(false)}
          saving={busy}
          testIdPrefix={`cal-${o.id}`}
        />
      ) : (
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={() => setConfirmLoss("lost")}
            aria-label="Mark lost"
            title="Mark lost"
            data-testid={`button-mark-lost-cal-${o.id}`}
          >
            <CircleX className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-muted-foreground"
            disabled={busy}
            onClick={() => setConfirmLoss("dormant")}
            aria-label="Mark dormant"
            title="Mark dormant"
            data-testid={`button-mark-dormant-cal-${o.id}`}
          >
            <PauseCircle className="h-4 w-4" />
          </Button>
          <RowActionIcons
            entityLabel={label}
            testIdPrefix={`cal-${o.id}`}
            onOpen={onOpen}
            onEdit={startEditDates}
            onArchive={onArchive}
            disabled={busy}
          />
        </div>
      );
    }
    return column.cell(o);
  };

  return (
    <TableRow className="hover:bg-muted/50" data-testid={`row-cal-${o.id}`}>
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={onSelect}
          aria-label={`Select ${label}`}
          data-testid={`checkbox-select-cal-${o.id}`}
        />
      </TableCell>
      {columns.map((column) => (
        <TableCell
          key={column.key}
          className={column.tdClassName}
          onClick={
            column.key === "actions"
              ? (event) => event.stopPropagation()
              : undefined
          }
        >
          {renderColumn(column)}
        </TableCell>
      ))}

      <AlertDialog
        open={confirmLoss !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmLoss(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {confirmLoss === "lost" ? "lost" : "dormant"}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-left">
              This sets {label}&apos;s loss type to{" "}
              {confirmLoss === "lost" ? "lost" : "dormant"}
              {o.actualCompletionDate
                ? ""
                : " and stamps today as the completion date"}
              , so it drops off this list. You can clear the loss type from the
              opportunity page to bring it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmResolve} disabled={busy}>
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TableRow>
  );
}
