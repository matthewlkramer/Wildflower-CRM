import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPeople,
  getListPeopleQueryKey,
  type ListPeopleParams,
  type CapacityRating,
} from "@workspace/api-client-react";
import {
  formatCapacity,
  formatCurrency,
  formatDateShort,
  formatFunderNameShort,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CreatePersonDialog } from "@/components/create-person-dialog";
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
const ANY = "_any";
// Capacity column + filter — same enum + labels we use on funders, just
// surfaced on individuals now that the field exists on people too.
const CAPACITY_TIERS: CapacityRating[] = [
  "tier_10k_50k",
  "tier_50k_250k",
  "tier_250k_1m",
  "tier_1m_plus",
];
const COL_SPAN = 9;

export default function Individuals() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [deceased, setDeceased] = useState<string>(ANY);
  const [capacity, setCapacity] = useState<string>(ANY);
  const [page, setPage] = useState(1);

  const params: ListPeopleParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(deceased !== ANY ? { deceased: deceased === "true" } : {}),
    ...(capacity !== ANY ? { capacityRating: capacity as CapacityRating } : {}),
  };

  const { data, isLoading, isError, error } = useListPeople(params, {
    query: { queryKey: getListPeopleQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const regionNames = useRegionNameMap();

  // Client-side sort + drag-to-resize for the current page of results.
  // The list endpoint doesn't accept a sort param yet, so this re-orders
  // the visible page only; widths are persisted per-table in localStorage.
  const ts = useTableState("individuals");
  const CAPACITY_ORDER: Record<string, number> = {
    tier_10k_50k: 1, tier_50k_250k: 2, tier_250k_1m: 3, tier_1m_plus: 4,
  };
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => personDisplayName(r).toLowerCase(),
          status: (r) => (r.deceased ? 1 : 0),
          region: (r) =>
            r.currentHomeRegionId
              ? (regionNames.get(r.currentHomeRegionId) ?? r.currentHomeRegionId)
              : null,
          capacity: (r) =>
            r.capacityRating ? (CAPACITY_ORDER[r.capacityRating] ?? 0) : null,
          lastContacted: (r) => r.lastContacted ?? null,
          lifetimeGiving: (r) =>
            r.lifetimeGiving != null ? Number(r.lifetimeGiving) : null,
          lastGift: (r) => r.mostRecentGiftDate ?? null,
          openAsks: (r) => r.openOpportunityCount ?? null,
          activeFunders: (r) => (r.activeFunderNames ?? []).length || null,
        },
        ts.sort,
      ),
    [rows, ts.sort, regionNames],
  );

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

      <div className="flex flex-wrap items-end gap-3">
        <div className="grow min-w-[200px]">
          <Input
            placeholder="Search by name…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            aria-label="Search people by name"
            data-testid="input-search-people"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-deceased" className="text-xs font-medium text-muted-foreground">
            Status
          </label>
          <Select
            value={deceased}
            onValueChange={(v) => {
              setDeceased(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="filter-deceased" className="w-[180px]" aria-label="Status" data-testid="select-deceased">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any</SelectItem>
              <SelectItem value="false">Living</SelectItem>
              <SelectItem value="true">Deceased</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-capacity" className="text-xs font-medium text-muted-foreground">
            Capacity
          </label>
          <Select
            value={capacity}
            onValueChange={(v) => {
              setCapacity(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="filter-capacity" className="w-[180px]" aria-label="Capacity" data-testid="select-capacity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any</SelectItem>
              {CAPACITY_TIERS.map((t) => (
                <SelectItem key={t} value={t}>{formatCapacity(t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(search || deceased !== ANY || capacity !== ANY) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setDeceased(ANY);
              setCapacity(ANY);
              setPage(1);
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
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="status" {...ts}>Status</SortableTH>
              <SortableTH colKey="region" {...ts}>Region</SortableTH>
              <SortableTH colKey="capacity" {...ts}>Capacity</SortableTH>
              <SortableTH colKey="lastContacted" {...ts}>Last contacted</SortableTH>
              <SortableTH colKey="lifetimeGiving" align="right" {...ts}>Lifetime giving</SortableTH>
              <SortableTH colKey="lastGift" {...ts}>Last gift</SortableTH>
              <SortableTH colKey="openAsks" align="right" {...ts}>Open asks</SortableTH>
              <SortableTH colKey="activeFunders" {...ts}>Active funders</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} className="text-center h-24 text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load people."}
                </TableCell>
              </TableRow>
            ) : sortedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COL_SPAN} className="text-center h-24 text-muted-foreground">
                  No people match these filters.
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((p) => {
                // Aggregates are best-effort. Lifetime "0" means we got a
                // SUM but there were no gifts; render "—" so the user
                // doesn't have to mentally distinguish $0 from "unset".
                const giving = p.lifetimeGiving;
                const hasGiving = giving != null && Number(giving) > 0;
                const openAsks = p.openOpportunityCount ?? 0;
                const funders = p.activeFunderNames ?? [];
                return (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    data-testid={`row-person-${p.id}`}
                  >
                    <TableCell className="font-medium">
                      <Link href={`/individuals/${p.id}`} className="block w-full">
                        {personDisplayName(p)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {p.deceased ? <Badge variant="outline">Deceased</Badge> : "—"}
                    </TableCell>
                    <TableCell>
                      {p.currentHomeRegionId
                        ? (regionNames.get(p.currentHomeRegionId) ?? p.currentHomeRegionId)
                        : "—"}
                    </TableCell>
                    <TableCell>{formatCapacity(p.capacityRating)}</TableCell>
                    <TableCell>{formatDateShort(p.lastContacted)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hasGiving ? formatCurrency(giving) : "—"}
                    </TableCell>
                    <TableCell>{formatDateShort(p.mostRecentGiftDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {openAsks > 0 ? openAsks : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[240px]">
                      {funders.length === 0
                        ? "—"
                        : funders.map(formatFunderNameShort).join(", ")}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

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
