import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPaymentIntermediaries,
  useUpdatePaymentIntermediary,
  useDeletePaymentIntermediary,
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
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { CreatePaymentIntermediaryDialog } from "@/components/create-payment-intermediary-dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

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
  onAskDelete: (p: PaymentIntermediary) => void;
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
            onOpen={() => ctx.onOpen(p)}
            onEdit={() => ctx.onStartEdit(p)}
            onDelete={() => ctx.onAskDelete(p)}
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
  const [deleteTarget, setDeleteTarget] = useState<PaymentIntermediary | null>(null);

  const ts = useTableState("payment-intermediaries");
  const sortActive = ts.sort.key !== null;

  const params: ListPaymentIntermediariesParams = {
    limit: sortActive ? 10000 : PAGE_SIZE,
    page: sortActive ? 1 : page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(typesSel.length > 0
      ? { type: typesSel[0] as PaymentIntermediaryType }
      : {}),
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

  const deleteMut = useDeletePaymentIntermediary({
    mutation: {
      onSuccess: async () => {
        await refresh();
        toast({ title: "Payment intermediary deleted" });
        setDeleteTarget(null);
      },
      onError: (err: unknown) => {
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

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
    onAskDelete: (p) => setDeleteTarget(p),
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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Payment Intermediaries</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
          </p>
        </div>
        <CreatePaymentIntermediaryDialog />
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
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            aria-label="Search payment intermediaries by name"
            data-testid="input-search-payint"
          />
        </div>
        {visibleFilters.map((f) => (
          <div key={f.key}>{f.render()}</div>
        ))}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearAll}>
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
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
              .map((p, idx, arr) => (
                <PaginationItem key={p}>
                  {idx > 0 && arr[idx - 1] !== p - 1 ? (
                    <span className="px-2 text-muted-foreground">…</span>
                  ) : null}
                  <PaginationLink
                    isActive={p === page}
                    onClick={() => setPage(p)}
                    className="cursor-pointer"
                  >
                    {p}
                  </PaginationLink>
                </PaginationItem>
              ))}
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

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
        title={deleteTarget ? `Delete ${deleteTarget.name}?` : "Delete payment intermediary?"}
        description="This will permanently remove this payment intermediary. This action cannot be undone."
        confirmTestId="button-confirm-delete-payint"
        onConfirm={() => {
          if (!deleteTarget) return;
          return deleteMut.mutateAsync({ id: deleteTarget.id });
        }}
      />
    </div>
  );
}
