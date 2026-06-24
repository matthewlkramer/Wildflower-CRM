import { useMemo } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListPeople,
  getListPeopleQueryKey,
  useListOrganizations,
  getListOrganizationsQueryKey,
  useGetCurrentUser,
  type ListPeopleParams,
  type ListOrganizationsParams,
  type Person,
  type Organization,
  type Priority,
} from "@workspace/api-client-react";
import { personDisplayName } from "@/lib/person";
import { formatDateShort, formatOrganizationNameShort } from "@/lib/format";
import { usePersistedState } from "@/hooks/use-persisted-state";
import {
  canSeeIdentity,
  displayPersonName,
  ANONYMOUS_LABEL,
} from "@/lib/visibility";
import { useUserNameMap } from "@/components/user-picker";
import { useRegionNameMap } from "@/components/region-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PriorityTooltip } from "@/components/priority-tooltip";
import { MultiFilterSelect } from "@/components/multi-filter-select";
import { OwnerMultiFilter } from "@/components/owner-multi-filter";
import { RegionMultiFilter } from "@/components/region-multi-filter";
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

type EntityMode = "individuals" | "organizations";

function affiliationNames(p: {
  activeFunderNames?: readonly string[] | null;
  activeOrganizationNames?: readonly string[] | null;
}): string[] {
  return [...(p.activeFunderNames ?? []), ...(p.activeOrganizationNames ?? [])];
}

// Oldest-contacted first; records never contacted bubble to the top.
function byOldestContact(
  a: { lastContacted?: string | null },
  b: { lastContacted?: string | null },
): number {
  if (a.lastContacted === b.lastContacted) return 0;
  if (!a.lastContacted) return -1;
  if (!b.lastContacted) return 1;
  return a.lastContacted.localeCompare(b.lastContacted);
}

export default function Moves() {
  // Persisted so the chosen entity + filters survive navigation to a record
  // detail and back.
  const [entity, setEntity] = usePersistedState<EntityMode>("wf.moves.entity", "individuals");
  const [owners, setOwners] = usePersistedState<string[]>("wf.moves.owners", []);
  const [priorities, setPriorities] = usePersistedState<string[]>("wf.moves.priorities", []);
  const [regionIds, setRegionIds] = usePersistedState<string[]>("wf.moves.regionIds", []);

  const isOrg = entity === "organizations";

  const peopleParams: ListPeopleParams = {
    deceased: false,
    limit: FETCH_LIMIT,
    page: 1,
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(priorities.length > 0 ? { priority: [...priorities].sort() as Priority[] } : {}),
    ...(regionIds.length > 0 ? { regionIds: [...regionIds].sort() } : {}),
  };

  const orgParams: ListOrganizationsParams = {
    limit: FETCH_LIMIT,
    page: 1,
    ...(owners.length > 0 ? { ownerUserId: [...owners].sort() } : {}),
    ...(priorities.length > 0 ? { priority: [...priorities].sort() as Priority[] } : {}),
    ...(regionIds.length > 0 ? { regionIds: [...regionIds].sort() } : {}),
  };

  const peopleQuery = useListPeople(peopleParams, {
    query: { queryKey: getListPeopleQueryKey(peopleParams), enabled: !isOrg },
  });
  const orgQuery = useListOrganizations(orgParams, {
    query: { queryKey: getListOrganizationsQueryKey(orgParams), enabled: isOrg },
  });

  const { data, isLoading, isError, error } = isOrg ? orgQuery : peopleQuery;

  const viewer = useGetCurrentUser().data ?? null;
  const userNames = useUserNameMap();
  const regionNames = useRegionNameMap();

  // Default sort matches the page's existing "oldest contact first" order.
  const ts = useTableState("moves", { key: "lastContacted", dir: "asc" });

  const sortedPeople = useMemo(
    () =>
      sortRows(
        (peopleQuery.data?.data ?? []).slice().sort(byOldestContact),
        {
          name: (r) => displayPersonName(r, viewer).toLowerCase(),
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
    [peopleQuery.data, ts.sort, userNames, regionNames, viewer],
  );

  const sortedOrgs = useMemo(
    () =>
      sortRows(
        (orgQuery.data?.data ?? []).slice().sort(byOldestContact),
        {
          name: (r) =>
            (canSeeIdentity(r, viewer)
              ? formatOrganizationNameShort(r.name)
              : ANONYMOUS_LABEL
            ).toLowerCase(),
          priority: (r) => (r.priority ? (PRIORITY_ORDER[r.priority] ?? 0) : null),
          region: (r) => {
            const ids = r.regionIds ?? [];
            return ids.length > 0
              ? ids.map((id) => regionNames.get(id) ?? id).join(", ").toLowerCase()
              : null;
          },
          owner: (r) =>
            r.ownerUserId ? (userNames.get(r.ownerUserId) ?? r.ownerUserId) : null,
          lastContacted: (r) => r.lastContacted ?? null,
          openAsks: (r) => r.openOpportunityCount ?? null,
        },
        ts.sort,
      ),
    [orgQuery.data, ts.sort, userNames, regionNames, viewer],
  );

  const colSpan = isOrg ? 6 : 7;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Moves</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isOrg
              ? "Organizations that could use a touch — ordered by oldest contact first."
              : "People who could use a touch — ordered by oldest contact first."}
            {data && data.pagination.total > FETCH_LIMIT ? (
              <span> Showing the first {FETCH_LIMIT} of {data.pagination.total.toLocaleString()}.</span>
            ) : null}
          </p>
        </div>
        <div className="flex rounded-md border overflow-hidden shrink-0">
          <Button
            variant={!isOrg ? "secondary" : "ghost"}
            size="sm"
            className="rounded-none border-0"
            onClick={() => setEntity("individuals")}
            aria-pressed={!isOrg}
            data-testid="toggle-moves-individuals"
          >
            Individuals
          </Button>
          <Button
            variant={isOrg ? "secondary" : "ghost"}
            size="sm"
            className="rounded-none border-0"
            onClick={() => setEntity("organizations")}
            aria-pressed={isOrg}
            data-testid="toggle-moves-organizations"
          >
            Organizations
          </Button>
        </div>
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
        <RegionMultiFilter
          selected={regionIds}
          onChange={setRegionIds}
          testId="select-move-region"
        />
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          {isOrg ? (
            <TableHeader>
              <TableRow>
                <SortableTH colKey="name" {...ts}>Name</SortableTH>
                <SortableTH colKey="priority" {...ts}>
                  <span className="inline-flex items-center gap-1">
                    Priority
                    <PriorityTooltip />
                  </span>
                </SortableTH>
                <SortableTH colKey="region" {...ts}>Region</SortableTH>
                <SortableTH colKey="owner" {...ts}>Owner</SortableTH>
                <SortableTH colKey="lastContacted" {...ts}>Last contacted</SortableTH>
                <SortableTH colKey="openAsks" align="right" {...ts}>Open asks</SortableTH>
              </TableRow>
            </TableHeader>
          ) : (
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
          )}
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={colSpan} />
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center h-24 text-destructive">
                  {error instanceof Error
                    ? error.message
                    : isOrg
                      ? "Failed to load organizations."
                      : "Failed to load people."}
                </TableCell>
              </TableRow>
            ) : isOrg ? (
              sortedOrgs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">
                    No organizations found.
                  </TableCell>
                </TableRow>
              ) : (
                sortedOrgs.map((o) => (
                  <TableRow key={o.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-move-${o.id}`}>
                    <TableCell className="font-medium">
                      <Link href={`/organizations/${o.id}`} className="block w-full">
                        {canSeeIdentity(o, viewer)
                          ? formatOrganizationNameShort(o.name)
                          : ANONYMOUS_LABEL}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {o.priority ? (
                        <Badge variant="outline">{PRIORITY_LABEL[o.priority] ?? o.priority}</Badge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {(o.regionIds ?? []).length > 0
                        ? (o.regionIds ?? []).map((id) => regionNames.get(id) ?? id).join(", ")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {o.ownerUserId
                        ? (userNames.get(o.ownerUserId) ?? o.ownerUserId)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {o.lastContacted ? formatDateShort(o.lastContacted) : (
                        <span className="text-muted-foreground italic">never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {o.openOpportunityCount && o.openOpportunityCount > 0
                        ? o.openOpportunityCount
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )
            ) : sortedPeople.length === 0 ? (
              <TableRow><TableCell colSpan={colSpan} className="text-center h-24 text-muted-foreground">No people found.</TableCell></TableRow>
            ) : (
              sortedPeople.map((p) => (
                <TableRow key={p.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-move-${p.id}`}>
                  <TableCell className="font-medium">
                    <Link href={`/individuals/${p.id}`} className="block w-full">
                      {displayPersonName(p, viewer)}
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
