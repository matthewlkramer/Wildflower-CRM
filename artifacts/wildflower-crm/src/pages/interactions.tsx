import { useMemo, useState } from "react";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
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
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { LogInteractionDialog } from "@/components/log-interaction-dialog";
import {
  MultiFilterSelect,
  type MultiFilterOption,
} from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { useUserNameMap } from "@/components/user-picker";

const PAGE_SIZE = 50;
const KIND_OPTIONS: MultiFilterOption[] = [
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
  const [kinds, setKinds] = useState<string[]>([]);
  const [owners, setOwners] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebounce(search, 250);
  const params: ListInteractionsParams = {
    limit: PAGE_SIZE,
    page,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(kinds.length > 0 ? { kind: [...kinds].sort() as InteractionKind[] } : {}),
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
  };
  const { data, isLoading } = useListInteractions(params);
  const userNames = useUserNameMap();
  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const ts = useTableState("interactions", { key: "when", dir: "desc" });
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          when: (r) => r.occurredAt,
          kind: (r) => r.kind,
          summary: (r) => r.summary?.toLowerCase() ?? null,
          location: (r) => r.location?.toLowerCase() ?? null,
          duration: (r) => r.durationMinutes ?? null,
          participants: (r) => participantCount(r),
          owner: (r) =>
            r.ownerUserId
              ? (userNames.get(r.ownerUserId) ?? r.ownerUserId).toLowerCase()
              : null,
        },
        ts.sort,
      ),
    [rows, ts.sort, userNames],
  );

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
      <div className="flex flex-wrap items-end gap-3">
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
        <MultiFilterSelect
          label="Kind"
          selected={kinds}
          onChange={(v) => {
            setKinds(v);
            setPage(1);
          }}
          options={KIND_OPTIONS}
          testId="select-filter-kind"
        />
        <OwnerMultiFilter
          selected={owners}
          onChange={(v) => {
            setOwners(v);
            setPage(1);
          }}
          testId="select-interaction-owner"
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableTH colKey="when" {...ts}>When</SortableTH>
            <SortableTH colKey="kind" {...ts}>Kind</SortableTH>
            <SortableTH colKey="summary" {...ts}>Summary</SortableTH>
            <SortableTH colKey="location" {...ts}>Location</SortableTH>
            <SortableTH colKey="duration" align="right" {...ts}>Duration</SortableTH>
            <SortableTH colKey="participants" align="right" {...ts}>Participants</SortableTH>
            <SortableTH colKey="owner" {...ts}>Owner</SortableTH>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : sortedRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                No interactions logged yet.
              </TableCell>
            </TableRow>
          ) : (
            sortedRows.map((r) => (
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
                <TableCell className="text-sm text-muted-foreground">
                  {r.ownerUserId
                    ? (userNames.get(r.ownerUserId) ?? r.ownerUserId)
                    : "—"}
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
