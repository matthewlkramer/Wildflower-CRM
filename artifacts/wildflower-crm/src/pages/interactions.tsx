import { useState } from "react";
import {
  useListInteractions,
  type Interaction,
  type InteractionKind,
  type ListInteractionsParams,
} from "@workspace/api-client-react";
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
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { LogInteractionDialog } from "@/components/log-interaction-dialog";

const PAGE_SIZE = 50;
const ANY = "_any";
const KIND_OPTIONS: { value: InteractionKind; label: string }[] = [
  { value: "meeting", label: "Meeting" },
  { value: "phone_call", label: "Phone call" },
  { value: "video_call", label: "Video call" },
  { value: "conference", label: "Conference" },
  { value: "other", label: "Other" },
];

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function participantCount(r: Interaction): number {
  return (
    (r.personIds?.length ?? 0) +
    (r.funderIds?.length ?? 0) +
    (r.householdIds?.length ?? 0)
  );
}

export default function Interactions() {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<InteractionKind | typeof ANY>(ANY);
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 250);
  const params: ListInteractionsParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(kind !== ANY ? { kind } : {}),
  };
  const { data, isLoading } = useListInteractions(params);
  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Interactions</h1>
          <p className="text-sm text-muted-foreground">
            Manually-logged touchpoints across people, funders, and households.
          </p>
        </div>
        <LogInteractionDialog />
      </div>
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search summary, notes, location…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
          data-testid="input-search-interactions"
        />
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v as InteractionKind | typeof ANY);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" data-testid="select-filter-kind">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All kinds</SelectItem>
            {KIND_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Summary</TableHead>
            <TableHead>Location</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Participants</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                No interactions logged yet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id} data-testid={`row-interaction-${r.id}`}>
                <TableCell className="whitespace-nowrap text-sm">
                  {formatWhen(r.occurredAt)}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{r.kind.replace(/_/g, " ")}</Badge>
                </TableCell>
                <TableCell className="max-w-md">
                  <div className="font-medium truncate">{r.summary}</div>
                  {r.notes ? (
                    <div className="text-xs text-muted-foreground truncate">
                      {r.notes}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {r.location ?? "—"}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {r.durationMinutes != null ? `${r.durationMinutes} min` : "—"}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {participantCount(r)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {pageCount > 1 ? (
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-disabled={page === 1}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink isActive>{page}</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                aria-disabled={page === pageCount}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      ) : null}
    </div>
  );
}
