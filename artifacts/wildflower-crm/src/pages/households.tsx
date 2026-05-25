import { useState } from "react";
import { Link } from "wouter";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CreateHouseholdDialog } from "@/components/create-household-dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

const PAGE_SIZE = 50;
const ANY = "_any";

export default function Households() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [active, setActive] = useState<string>(ANY);
  const [page, setPage] = useState(1);

  const params: ListHouseholdsParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(active !== ANY ? { active: active === "true" } : {}),
  };

  const { data, isLoading, isError, error } = useListHouseholds(params, {
    query: { queryKey: getListHouseholdsQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-household-active" className="text-xs font-medium text-muted-foreground">
            Status
          </label>
          <Select
            value={active}
            onValueChange={(v) => {
              setActive(v);
              setPage(1);
            }}
          >
            <SelectTrigger id="filter-household-active" className="w-[180px]" aria-label="Status" data-testid="select-household-active">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any</SelectItem>
              <SelectItem value="true">Active</SelectItem>
              <SelectItem value="false">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(search || active !== ANY) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setActive(ANY);
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
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Lifetime giving</TableHead>
              <TableHead>Last gift</TableHead>
              <TableHead className="text-right">Open asks</TableHead>
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
              rows.map((h) => {
                // See individuals.tsx — "0" giving renders as "—" so the
                // user doesn't have to disambiguate $0 from "unset".
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
