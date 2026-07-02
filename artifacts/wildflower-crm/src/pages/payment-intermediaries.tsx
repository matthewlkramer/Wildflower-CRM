import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPaymentIntermediaries,
  useUpdatePaymentIntermediary,
  useArchivePaymentIntermediary,
  useUnarchivePaymentIntermediary,
  getListPaymentIntermediariesQueryKey,
  type ListPaymentIntermediariesParams,
  type PaymentIntermediary,
  PaymentIntermediaryType,
} from "@workspace/api-client-react";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useSavedViews } from "@/hooks/use-saved-views";
import { SavedViewsBar } from "@/components/saved-views-bar";
import { ColumnsMenu } from "@/components/columns-menu";
import { FiltersMenu } from "@/components/filters-menu";
import { resolveColumns, type ColumnDef, type ColumnsState } from "@/lib/columns";
import { resolveFilters, type FilterDef, type FiltersState } from "@/lib/filters";
import { formatEnum } from "@/lib/format";
import {
  INTERMEDIARY_TYPES,
  NONE_TYPE,
  intermediaryTypeLabel,
} from "@/lib/payment-intermediary";
import { useDebounce } from "@/hooks/use-debounce";
import { useToast } from "@/hooks/use-toast";
import type { SortState } from "@/lib/table-helpers";
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
import { X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import {
  RowActionIcons,
  InlineRowSaveActions,
} from "@/components/row-action-icons";
import { ShowArchivedToggle } from "@/components/show-archived-toggle";
import { ListPageHeader } from "@/components/list-page-header";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { CreatePaymentIntermediaryDialog } from "@/components/create-payment-intermediary-dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { PageJumper } from "@/components/page-jumper";

const PAGE_SIZE = 50;

type RowEditContext = {
  editingId: string | null;
  draftName: string;
  draftType: string;
  setDraftName: (v: string) => void;
  setDraftType: (v: string) => void;
  isSaving: boolean;
  onStartEdit: (p: PaymentIntermediary) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onOpen: (p: PaymentIntermediary) => void;
  onArchive: (p: PaymentIntermediary) => void;
  onUnarchive: (p: PaymentIntermediary) => void;
  isAdmin: boolean;
};

function buildColumns(ctx: RowEditContext): ColumnDef<PaymentIntermediary>[] {
  const isEditing = (p: PaymentIntermediary) => ctx.editingId === p.id;
  return [
    {
      key: "name",
      label: "Name",
      required: true,
      tdClassName: "font-medium",
      cell: (p) =>
        isEditing(p) ? (
          <Input
            value={ctx.draftName}
            onChange={(e) => ctx.setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ctx.onSaveEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                ctx.onCancelEdit();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="h-8"
            aria-label="Name"
            data-testid={`input-inline-name-payint-${p.id}`}
          />
        ) : (
          <Link
            href={`/payment-intermediaries/${p.id}`}
            className="block w-full hover:underline"
          >
            {p.name}
          </Link>
        ),
    },
    {
      key: "type",
      label: "Type",
      cell: (p) =>
        isEditing(p) ? (
          <Select value={ctx.draftType} onValueChange={ctx.setDraftType}>
            <SelectTrigger
              className="h-8"
              aria-label="Type"
              data-testid={`select-inline-type-payint-${p.id}`}
            >
              <SelectValue placeholder="Select a type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_TYPE}>None</SelectItem>
              {INTERMEDIARY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {intermediaryTypeLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : p.type ? (
          <Badge variant="outline">
            {p.type === PaymentIntermediaryType.daf ? "DAF" : formatEnum(p.type)}
          </Badge>
        ) : (
          "—"
        ),
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
        isEditing(p) ? (
          <InlineRowSaveActions
            onSave={ctx.onSaveEdit}
            onCancel={ctx.onCancelEdit}
            saving={ctx.isSaving}
            saveDisabled={!ctx.draftName.trim()}
            testIdPrefix={`payint-${p.id}`}
          />
        ) : (
          <RowActionIcons
            entityLabel={p.name}
            testIdPrefix={`payint-${p.id}`}
            disabled={ctx.editingId !== null}
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

type PaymentIntermediariesView = {
  search: string;
  types: string[];
  sort: SortState;
  columns: ColumnsState | null;
  filters: FiltersState | null;
};

export default function PaymentIntermediaries() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = usePersistedState<string>("wf.list.payint.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [typesSel, setTypesSel] = usePersistedState<string[]>("wf.list.payint.types", []);
  const [page, setPage] = usePersistedState<number>("wf.list.payint.page", 1);
  const [columnsState, setColumnsState] = usePersistedState<ColumnsState | null>(
    "wf.list.payint.columns",
    null,
  );
  const [filtersState, setFiltersState] = usePersistedState<FiltersState | null>(
    "wf.list.payint.filters",
    null,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<string>(NONE_TYPE);

  const isAdmin = useIsAdmin();
  const [showArchived, setShowArchived] = usePersistedState<boolean>(
    "wf.list.payint.showArchived",
    false,
  );

  const ts = useTableState("payment-intermediaries");
  const sortActive = ts.sort.key !== null;

  const params: ListPaymentIntermediariesParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(typesSel.length > 0
      ? { type: typesSel[0] as PaymentIntermediaryType }
      : {}),
    ...(isAdmin && showArchived ? { includeArchived: true } : {}),
  };

  const { data, isLoading, isError } = useListPaymentIntermediaries(params, {
    query: { queryKey: getListPaymentIntermediariesQueryKey(params) },
  });

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getListPaymentIntermediariesQueryKey(),
    });

  const updateMut = useUpdatePaymentIntermediary({
    mutation: {
      onSuccess: async () => {
        await refresh();
        toast({ title: "Payment intermediary updated" });
        setEditingId(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  const archiveMut = useArchivePaymentIntermediary();
  const unarchiveMut = useUnarchivePaymentIntermediary();

  const archivePi = (p: PaymentIntermediary) =>
    archiveMut.mutate(
      { id: p.id },
      {
        onSuccess: async () => {
          await refresh();
          toast({ title: "Payment intermediary archived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Archive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const unarchivePi = (p: PaymentIntermediary) =>
    unarchiveMut.mutate(
      { id: p.id },
      {
        onSuccess: async () => {
          await refresh();
          toast({ title: "Payment intermediary unarchived" });
        },
        onError: (err: unknown) =>
          toast({
            title: "Unarchive failed",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          }),
      },
    );

  const startEdit = (p: PaymentIntermediary) => {
    setEditingId(p.id);
    setDraftName(p.name);
    setDraftType(p.type ?? NONE_TYPE);
  };
  const cancelEdit = () => setEditingId(null);
  const saveEdit = () => {
    const trimmed = draftName.trim();
    if (!trimmed || !editingId) return;
    updateMut.mutate({
      id: editingId,
      data: {
        name: trimmed,
        type: draftType === NONE_TYPE ? null : (draftType as PaymentIntermediaryType),
      },
    });
  };

  const rawRows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const editCtx: RowEditContext = {
    editingId,
    draftName,
    draftType,
    setDraftName,
    setDraftType,
    isSaving: updateMut.isPending,
    onStartEdit: startEdit,
    onCancelEdit: cancelEdit,
    onSaveEdit: saveEdit,
    onOpen: (p) => navigate(`/payment-intermediaries/${p.id}`),
    onArchive: archivePi,
    onUnarchive: unarchivePi,
    isAdmin,
  };

  const registry = buildColumns(editCtx);
  const visibleCols = useMemo(
    () => resolveColumns(registry, columnsState),
    [registry, columnsState],
  );
  const colSpan = visibleCols.length;

  const sortedRows = useMemo(
    () =>
      sortRows(
        rawRows,
        {
          name: (r) => r.name.toLowerCase(),
          type: (r) => r.type ?? "",
        },
        ts.sort,
      ),
    [rawRows, ts.sort],
  );

  const pagedRows = useMemo(() => {
    if (!sortActive) return sortedRows;
    const maxPage = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), maxPage);
    return sortedRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  }, [sortActive, sortedRows, page]);

  const filterRegistry = useMemo<FilterDef[]>(
    () => [
      {
        key: "type",
        label: "Type",
        active: typesSel.length > 0,
        clear: () => { setTypesSel([]); setPage(1); },
        render: () => (
          <MultiFilterSelect
            label="Type"
            selected={typesSel}
            onChange={(v) => { setTypesSel(v.slice(0, 1)); setPage(1); }}
            options={INTERMEDIARY_TYPES}
            testId="select-payint-type"
          />
        ),
      },
    ],
    [typesSel, setTypesSel, setPage],
  );

  const visibleFilters = useMemo(
    () => resolveFilters(filterRegistry, filtersState),
    [filterRegistry, filtersState],
  );

  const hasActiveFilters = !!search || typesSel.length > 0;

  const clearAll = () => {
    setSearch("");
    setTypesSel([]);
    ts.setSort({ key: null, dir: "asc" });
    setPage(1);
  };

  const currentView: PaymentIntermediariesView = {
    search,
    types: typesSel,
    sort: ts.sort,
    columns: columnsState,
    filters: filtersState,
  };

  const viewsCtrl = useSavedViews<PaymentIntermediariesView>({
    listKey: "payment-intermediaries",
    current: currentView,
    apply: (s) => {
      setSearch(s.search ?? "");
      setTypesSel(s.types ?? []);
      ts.setSort(s.sort ?? { key: null, dir: "asc" });
      setColumnsState(s.columns ?? null);
      setFiltersState(s.filters ?? null);
      setPage(1);
    },
    isDefault: (s) =>
      !s.search &&
      (s.types?.length ?? 0) === 0 &&
      (s.sort?.key ?? null) === null &&
      (s.columns ?? null) === null &&
      (s.filters ?? null) === null,
  });

  return (
    <div className="space-y-4">
      <ListPageHeader
        title="Payment Intermediaries"
        subtitle={isLoading ? "Loading…" : `${total.toLocaleString()} total`}
        addAction={<CreatePaymentIntermediaryDialog />}
        controls={
          <>
            <ShowArchivedToggle value={showArchived} onChange={setShowArchived} />
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

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <div className="relative">
            <Input
              placeholder="Search by name…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              aria-label="Search payment intermediaries by name"
              data-testid="input-search-payint"
              className="pr-8"
            />
            {search && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="no-default-hover-elevate no-default-active-elevate absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => { setSearch(""); setPage(1); }}
                aria-label="Clear search"
                data-testid="button-clear-search-payint"
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
          <Button variant="ghost" size="sm" onClick={clearAll}>
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-md border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {visibleCols.map((col) => (
                <SortableTH
                  key={col.key}
                  colKey={col.sortKey ?? col.key}
                  sortable={col.sortable}
                  align={col.align}
                  className={col.thClassName}
                  {...ts}
                >
                  {col.header ?? col.label}
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
                  Failed to load payment intermediaries.
                </TableCell>
              </TableRow>
            ) : pagedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">
                  No payment intermediaries match these filters.
                </TableCell>
              </TableRow>
            ) : (
              pagedRows.map((row) => (
                <TableRow
                  key={row.id}
                  className="hover:bg-muted/50 transition-colors"
                  data-testid={`row-payint-${row.id}`}
                >
                  {visibleCols.map((col) => (
                    <TableCell key={col.key} className={col.tdClassName}>
                      {col.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                onClick={() => setPage(Math.max(1, page - 1))}
                aria-disabled={page <= 1}
                className={page <= 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
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
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                aria-disabled={page >= totalPages}
                className={page >= totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
