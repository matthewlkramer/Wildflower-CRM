import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListFunders,
  getListFundersQueryKey,
  useBulkUpdateFunders,
  type ListFundersParams,
  type FundingEntitySubtype,
  type ConnectionStatus,
  type ActiveStatus,
} from "@workspace/api-client-react";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { FUNDERS_BULK_FIELDS } from "@/lib/bulk-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCapacity, formatCurrency, formatEnum, formatFunderNameShort } from "@/lib/format";
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
import { CreateFunderDialog } from "@/components/create-funder-dialog";
import { PriorityStar } from "@/components/priority-star";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

const SUBTYPES: FundingEntitySubtype[] = [
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
const DEFAULT_EXCLUDED_SUBTYPES: FundingEntitySubtype[] = [
  "nonprofit",
  "education_forprofit",
  "corporation",
  "daf_platform",
  "platform",
  "capital_provider",
];
const DEFAULT_SUBTYPES: FundingEntitySubtype[] = SUBTYPES.filter(
  (s) => !DEFAULT_EXCLUDED_SUBTYPES.includes(s),
);

const ACTIVE_STATUSES: ActiveStatus[] = ["active", "defunct", "spenddown"];
const DEFAULT_ACTIVE_STATUSES: ActiveStatus[] = ["active", "spenddown"];
const CONNECTION_STATUSES: ConnectionStatus[] = [
  "connected",
  "have_a_connector",
  "no_connection",
];

const PAGE_SIZE = 50;

export default function FundingEntities() {
  // Filter state persists per-tab so back-navigation from a funder
  // detail restores the same filtered view.
  const [search, setSearch] = usePersistedState<string>("wf.list.funders.search", "");
  const debouncedSearch = useDebounce(search, 250);
  const [subtypes, setSubtypes] = usePersistedState<string[]>("wf.list.funders.subtypes", DEFAULT_SUBTYPES);
  const [activeStatuses, setActiveStatuses] = usePersistedState<string[]>("wf.list.funders.activeStatuses", DEFAULT_ACTIVE_STATUSES);
  const [connectionStatuses, setConnectionStatuses] = usePersistedState<string[]>("wf.list.funders.connectionStatuses", []);
  const [owners, setOwners] = usePersistedState<string[]>("wf.list.funders.owners", []);
  const [page, setPage] = usePersistedState<number>("wf.list.funders.page", 1);
  const selection = useRowSelection();
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkMut = useBulkUpdateFunders();

  const params: ListFundersParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(subtypes.length > 0 ? { subtype: [...subtypes].sort() as FundingEntitySubtype[] } : {}),
    ...(activeStatuses.length > 0
      ? { activeStatus: [...activeStatuses].sort() as ActiveStatus[] }
      : {}),
    ...(connectionStatuses.length > 0
      ? { connectionStatus: [...connectionStatuses].sort() as ConnectionStatus[] }
      : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
  };

  const { data, isLoading, isError, error } = useListFunders(params, {
    query: { queryKey: getListFundersQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const ts = useTableState("funding-entities");
  const userNames = useUserNameMap();
  const CAPACITY_ORDER: Record<string, number> = {
    tier_10k_50k: 1, tier_50k_250k: 2, tier_250k_1m: 3, tier_1m_plus: 4,
  };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          priority: (r) => (r.isPriority ? 1 : 0),
          name: (r) => formatFunderNameShort(r.name).toLowerCase(),
          subtype: (r) => r.fundingEntitySubtype ?? null,
          active: (r) => r.activeStatus ?? null,
          connection: (r) => r.connectionStatus ?? null,
          enthusiasm: (r) => r.enthusiasm ?? null,
          capacity: (r) =>
            r.capacityRating ? (CAPACITY_ORDER[r.capacityRating] ?? 0) : null,
          primaryContact: (r) => r.primaryContactPersonName?.toLowerCase() ?? null,
          lifetimeGiving: (r) =>
            r.lifetimeGiving != null ? Number(r.lifetimeGiving) : null,
          openAsks: (r) => r.openOpportunityCount ?? null,
          owner: (r) =>
            r.ownerUserId
              ? (userNames.get(r.ownerUserId) ?? r.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [rows, ts.sort, userNames],
  );

  const sortedDefaultActiveStatuses = [...DEFAULT_ACTIVE_STATUSES].sort().join(",");
  const sameDefaultActiveStatuses =
    [...activeStatuses].sort().join(",") === sortedDefaultActiveStatuses;
  const sortedDefaultSubtypes = [...DEFAULT_SUBTYPES].sort().join(",");
  const sameDefaultSubtypes =
    [...subtypes].sort().join(",") === sortedDefaultSubtypes;
  const hasActiveFilters =
    !!search ||
    !sameDefaultSubtypes ||
    !sameDefaultActiveStatuses ||
    connectionStatuses.length > 0 ||
    owners.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">
            Funders
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
          </p>
        </div>
        <CreateFunderDialog />
      </div>

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

        <MultiFilterSelect
          label="Subtype"
          selected={subtypes}
          onChange={(v) => { setSubtypes(v); setPage(1); selection.clear(); }}
          options={SUBTYPES}
          testId="select-subtype"
        />
        <MultiFilterSelect
          label="Active status"
          selected={activeStatuses}
          onChange={(v) => { setActiveStatuses(v); setPage(1); selection.clear(); }}
          options={ACTIVE_STATUSES}
          testId="select-active-status"
        />
        <MultiFilterSelect
          label="Connection"
          selected={connectionStatuses}
          onChange={(v) => { setConnectionStatuses(v); setPage(1); selection.clear(); }}
          options={CONNECTION_STATUSES}
          testId="select-connection-status"
        />
        <OwnerMultiFilter
          selected={owners}
          onChange={(v) => { setOwners(v); setPage(1); selection.clear(); }}
          testId="select-funder-owner"
        />

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setSubtypes(DEFAULT_SUBTYPES);
              setActiveStatuses(DEFAULT_ACTIVE_STATUSES);
              setConnectionStatuses([]);
              setOwners([]);
              setPage(1);
              selection.clear();
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
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
                  aria-label="Select all funders on this page"
                  data-testid="checkbox-select-all-funders"
                />
              </TableHead>
              <SortableTH colKey="priority" {...ts}><span className="sr-only">Priority</span></SortableTH>
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="subtype" {...ts}>Subtype</SortableTH>
              <SortableTH colKey="active" {...ts}>Active</SortableTH>
              <SortableTH colKey="connection" {...ts}>Connection</SortableTH>
              <SortableTH colKey="enthusiasm" {...ts}>Enthusiasm</SortableTH>
              <SortableTH colKey="capacity" {...ts}>Capacity</SortableTH>
              <SortableTH colKey="primaryContact" {...ts}>Primary contact</SortableTH>
              <SortableTH colKey="lifetimeGiving" align="right" {...ts}>Lifetime giving</SortableTH>
              <SortableTH colKey="openAsks" align="right" {...ts}>Open asks</SortableTH>
              <SortableTH colKey="owner" {...ts}>Owner</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={12}
                  className="text-center h-24 text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell
                  colSpan={12}
                  className="text-center h-24 text-destructive"
                >
                  {error instanceof Error
                    ? error.message
                    : "Failed to load funders."}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={12}
                  className="text-center h-24 text-muted-foreground"
                >
                  No funders match these filters.
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((f) => {
                const hasGiving = f.lifetimeGiving != null && Number(f.lifetimeGiving) > 0;
                const openAsks = f.openOpportunityCount ?? 0;
                return (
                  <TableRow
                    key={f.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    data-testid={`row-funder-${f.id}`}
                  >
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selection.isSelected(f.id)}
                        onCheckedChange={() => selection.toggle(f.id)}
                        aria-label={`Select ${f.name}`}
                        data-testid={`checkbox-select-${f.id}`}
                      />
                    </TableCell>
                    <TableCell className="w-8 pr-0">
                      <PriorityStar kind="funder" id={f.id} isPriority={f.isPriority} />
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link
                        href={`/funding-entities/${f.id}`}
                        className="block w-full"
                      >
                        {formatFunderNameShort(f.name)}
                      </Link>
                    </TableCell>
                    <TableCell>{formatEnum(f.fundingEntitySubtype)}</TableCell>
                    <TableCell>
                      {f.activeStatus ? (
                        <Badge
                          variant={
                            f.activeStatus === "active" ? "default" : "outline"
                          }
                        >
                          {formatEnum(f.activeStatus)}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{formatEnum(f.connectionStatus)}</TableCell>
                    <TableCell>{formatEnum(f.enthusiasm)}</TableCell>
                    <TableCell>{formatCapacity(f.capacityRating)}</TableCell>
                    <TableCell>
                      {f.primaryContactPersonId ? (
                        <Link
                          href={`/individuals/${f.primaryContactPersonId}`}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {f.primaryContactPersonName ?? f.primaryContactPersonId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hasGiving ? formatCurrency(f.lifetimeGiving) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {openAsks > 0 ? openAsks : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {f.ownerUserId
                        ? (userNames.get(f.ownerUserId) ?? f.ownerUserId)
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
        entityNoun="funder"
      />
      <BulkEditDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        entityNoun="funder"
        selectedIds={selection.selectedIds}
        fields={FUNDERS_BULK_FIELDS}
        invalidateKeys={[getListFundersQueryKey()]}
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
