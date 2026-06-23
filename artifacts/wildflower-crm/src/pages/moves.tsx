import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPeople,
  getListPeopleQueryKey,
  type ListPeopleParams,
  type Priority,
} from "@workspace/api-client-react";
import { personDisplayName } from "@/lib/person";
import { formatDateShort } from "@/lib/format";
import { useUserNameMap } from "@/components/user-picker";
import { useRegionNameMap } from "@/components/region-picker";
import { Badge } from "@/components/ui/badge";
import { PriorityTooltip } from "@/components/priority-tooltip";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkeletonRows } from "@/components/ui/skeleton";

const FETCH_LIMIT = 200;
const PRIORITIES: Priority[] = ["top", "high", "medium", "low"];
const PRIORITY_LABEL: Record<string, string> = { top: "Top", high: "High", medium: "Medium", low: "Low" };
const PRIORITY_ORDER: Record<string, number> = { top: 4, high: 3, medium: 2, low: 1 };

function affiliationNames(p: {
  activeFunderNames?: readonly string[] | null;
  activeOrganizationNames?: readonly string[] | null;
}): string[] {
  return [...(p.activeFunderNames ?? []), ...(p.activeOrganizationNames ?? [])];
}

export default function Moves() {
  const [owners, setOwners] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<string[]>([]);

  const params: ListPeopleParams = {
    deceased: false,
    limit: FETCH_LIMIT,
    page: 1,
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(priorities.length > 0 ? { priority: [...priorities].sort() as Priority[] } : {}),
  };

  const { data, isLoading, isError, error } = useListPeople(params, {
    query: { queryKey: getListPeopleQueryKey(params) },
  });

  const rows = useMemo(() => {
    const all = data?.data ?? [];
    // Oldest-contacted first; people never contacted bubble to the top.
    return all.slice().sort((a, b) => {
      if (a.lastContacted === b.lastContacted) return 0;
      if (!a.lastContacted) return -1;
      if (!b.lastContacted) return 1;
      return a.lastContacted.localeCompare(b.lastContacted);
    });
  }, [data]);

  const userNames = useUserNameMap();
  const regionNames = useRegionNameMap();

  // Default sort matches the page's existing "oldest contact first" order.
  const ts = useTableState("moves", { key: "lastContacted", dir: "asc" });
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        {
          name: (r) => personDisplayName(r).toLowerCase(),
          lastContacted: (r) => r.lastContacted ?? null,
          interactions: (r) => r.interactionCount ?? null,
          priority: (r) => (r.priority ? (PRIORITY_ORDER[r.priority] ?? 0) : null),
          owner: (r) =>
            r.ownerUserId ? (userNames.get(r.ownerUserId) ?? r.ownerUserId) : null,
          region: (r) =>
            r.currentHomeRegionId
              ? (regionNames.get(r.currentHomeRegionId) ?? r.currentHomeRegionId)
              : null,
          affiliation: (r) => affiliationNames(r).join(", ").toLowerCase() || null,
        },
        ts.sort,
      ),
    [rows, ts.sort, userNames, regionNames],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Moves</h1>
        <p className="text-sm text-muted-foreground mt-1">
          People who could use a touch — ordered by oldest contact first.
          {data && data.pagination.total > FETCH_LIMIT ? (
            <span> Showing the first {FETCH_LIMIT} of {data.pagination.total.toLocaleString()}.</span>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <OwnerMultiFilter
          selected={owners}
          onChange={setOwners}
          testId="select-move-owner"
        />
        <MultiFilterSelect
          label="Priority"
          selected={priorities}
          onChange={setPriorities}
          options={PRIORITIES}
          testId="select-move-priority"
          includeBlank
        />
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="lastContacted" {...ts}>Last contacted</SortableTH>
              <SortableTH colKey="interactions" align="right" {...ts}>Interactions</SortableTH>
              <SortableTH colKey="priority" {...ts}>
                <span className="inline-flex items-center gap-1">
                  Priority
                  <PriorityTooltip />
                </span>
              </SortableTH>
              <SortableTH colKey="owner" {...ts}>Owner</SortableTH>
              <SortableTH colKey="region" {...ts}>Region</SortableTH>
              <SortableTH colKey="affiliation" {...ts}>Funder / Organization</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={7} />
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load people."}
                </TableCell>
              </TableRow>
            ) : sortedRows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">No people found.</TableCell></TableRow>
            ) : (
              sortedRows.map((p) => (
                <TableRow key={p.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-move-${p.id}`}>
                  <TableCell className="font-medium">
                    <Link href={`/individuals/${p.id}`} className="block w-full">
                      {personDisplayName(p)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {p.lastContacted ? formatDateShort(p.lastContacted) : (
                      <span className="text-muted-foreground italic">never</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{p.interactionCount ?? "—"}</TableCell>
                  <TableCell>
                    {p.priority ? (
                      <Badge variant="outline">{PRIORITY_LABEL[p.priority] ?? p.priority}</Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {p.ownerUserId
                      ? (userNames.get(p.ownerUserId) ?? p.ownerUserId)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {p.currentHomeRegionId
                      ? (regionNames.get(p.currentHomeRegionId) ?? p.currentHomeRegionId)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {affiliationNames(p).length > 0
                      ? affiliationNames(p).join(", ")
                      : "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
