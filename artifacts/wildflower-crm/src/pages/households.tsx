import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListHouseholds,
  getListHouseholdsQueryKey,
  type ListHouseholdsParams,
} from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { formatCurrency, formatDateShort } from "@/lib/format";
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
import { CreateHouseholdDialog } from "@/components/create-household-dialog";
import {
  MultiFilterSelect,
  type MultiFilterOption,
} from "@/components/multi-filter-select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

const PAGE_SIZE = 50;
// Active/Inactive is conceptually boolean but rendered as a
// multi-select for UI consistency with every other filter on the page.
// 0 or 2 selected → unfiltered; exactly 1 → send the single boolean.
const ACTIVE_OPTIONS: MultiFilterOption[] = [
  { value: "true", label: "Active" },
  { value: "false", label: "Inactive" },
];

export default function Households() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [activeSel, setActiveSel] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const params: ListHouseholdsParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(activeSel.length === 1 ? { active: activeSel[0] === "true" } : {}),
  };

  const { data, isLoading, isError, error } = useListHouseholds(params, {
    query: { queryKey: getListHouseholdsQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const ts = useTableState("households");
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => r.name.toLowerCase(),
          status: (r) => (r.active ? 1 : 0),
          lifetimeGiving: (r) =>
            r.lifetimeGiving != null ? Number(r.lifetimeGiving) : null,
          lastGift: (r) => r.mostRecentGiftDate ?? null,
          openAsks: (r) => r.openOpportunityCount ?? null,
        },
        ts.sort,
      ),
    [rows, ts.sort],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Households</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
          </p>
        </div>
        <CreateHouseholdDialog />
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
            aria-label="Search households by name"
            data-testid="input-search-households"
          />
        </div>
        <MultiFilterSelect
          label="Status"
          selected={activeSel}
          onChange={(v) => { setActiveSel(v); setPage(1); }}
          options={ACTIVE_OPTIONS}
          testId="select-household-active"
        />
        {(search || activeSel.length > 0) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setActiveSel([]);
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
              <SortableTH colKey="lifetimeGiving" align="right" {...ts}>Lifetime giving</SortableTH>
              <SortableTH colKey="lastGift" {...ts}>Last gift</SortableTH>
              <SortableTH colKey="openAsks" align="right" {...ts}>Open asks</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load households."}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                  No households match these filters.
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((h) => {
                const hasGiving = h.lifetimeGiving != null && Number(h.lifetimeGiving) > 0;
                const openAsks = h.openOpportunityCount ?? 0;
                return (
                  <TableRow
                    key={h.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    data-testid={`row-household-${h.id}`}
                  >
                    <TableCell className="font-medium">
                      <Link href={`/households/${h.id}`} className="block w-full">{h.name}</Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={h.active ? "default" : "outline"}>
                        {h.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {hasGiving ? formatCurrency(h.lifetimeGiving) : "—"}
                    </TableCell>
                    <TableCell>{formatDateShort(h.mostRecentGiftDate)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {openAsks > 0 ? openAsks : "—"}
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
                onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(1, p - 1)); }}
                aria-disabled={page <= 1}
                className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>{page} / {totalPages}</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(totalPages, p + 1)); }}
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
