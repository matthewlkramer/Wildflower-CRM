import { useState } from "react";
import { Link } from "wouter";
import {
  useListPeople,
  getListPeopleQueryKey,
  type ListPeopleParams,
} from "@workspace/api-client-react";
import { formatDate } from "@/lib/format";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
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

export default function Individuals() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);
  const [deceased, setDeceased] = useState<string>(ANY);
  const [page, setPage] = useState(1);

  const params: ListPeopleParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
    ...(deceased !== ANY ? { deceased: deceased === "true" } : {}),
  };

  const { data, isLoading, isError, error } = useListPeople(params, {
    query: { queryKey: getListPeopleQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Individuals
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
        </p>
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

        {(search || deceased !== ANY) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setDeceased(ANY);
              setPage(1);
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
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Last contacted</TableHead>
              <TableHead>Tags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load people."}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">
                  No people match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => (
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
                  <TableCell>{p.currentHomeRegionId ?? "—"}</TableCell>
                  <TableCell>{formatDate(p.lastContacted)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {p.tags ?? "—"}
                  </TableCell>
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
