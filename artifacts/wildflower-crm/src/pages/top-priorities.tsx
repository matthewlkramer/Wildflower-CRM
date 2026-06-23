import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetTopPriorities,
  getGetTopPrioritiesQueryKey,
  useGetCurrentUser,
  type TopPriorityOrganization,
  type TopPriorityPerson,
  type TopPriorityAffiliate,
  type TopPriorityOpenAsk,
} from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { PriorityStar } from "@/components/priority-star";
import { useUserNameMap } from "@/components/user-picker";
import { ANONYMOUS_LABEL, type Viewer } from "@/lib/visibility";
import { personDisplayName } from "@/lib/person";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import { Star } from "lucide-react";

// Names are already masked server-side; render the label as-is.
function FunderNameCell({ funder }: { funder: TopPriorityOrganization }) {
  return (
    <div className="flex items-center gap-1.5">
      <PriorityStar priority="top" size="sm" />
      <Link href={`/organizations/${funder.id}`} className="text-primary hover:underline font-medium">
        {funder.name}
      </Link>
    </div>
  );
}

function PersonNameCell({ person, viewer }: { person: TopPriorityPerson; viewer: Viewer }) {
  // Server already masked the name; personDisplayName just formats first/last/fullName.
  const label = person.anonymous && !person.fullName && !person.firstName
    ? ANONYMOUS_LABEL
    : personDisplayName({
        fullName: person.fullName,
        firstName: person.firstName,
        lastName: person.lastName,
        nickname: null,
        id: person.id,
      });
  void viewer; // viewer kept for future client-side concerns; masking is server-side
  return (
    <div className="flex items-center gap-1.5">
      <PriorityStar priority="top" size="sm" />
      <Link href={`/individuals/${person.id}`} className="text-primary hover:underline font-medium">
        {label}
      </Link>
    </div>
  );
}

function AffiliatedPeopleCell({ people }: { people: TopPriorityAffiliate[] }) {
  if (!people || people.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-x-1">
      {people.map((p, idx) => (
        <span key={p.personId}>
          <Link href={`/individuals/${p.personId}`} className="text-primary hover:underline">
            {p.personName}
          </Link>
          {idx < people.length - 1 && <span className="text-muted-foreground">, </span>}
        </span>
      ))}
    </div>
  );
}

function OpenAsksCell({ asks }: { asks: TopPriorityOpenAsk[] }) {
  if (!asks || asks.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-x-1">
      {asks.map((a, idx) => (
        <span key={a.opportunityId}>
          <Link href={`/opportunities/${a.opportunityId}`} className="text-primary hover:underline">
            {a.opportunityName}
          </Link>
          {idx < asks.length - 1 && <span className="text-muted-foreground">, </span>}
        </span>
      ))}
    </div>
  );
}

function FundersTable({
  funders,
  viewer,
  loading,
}: {
  funders: TopPriorityOrganization[];
  viewer: Viewer;
  loading: boolean;
}) {
  const ts = useTableState("top-priority-funders", { key: "name" });
  const userNames = useUserNameMap();

  const sorted = useMemo(
    () =>
      sortRows(funders, {
        name: (f) => f.name,
        owner: (f) => (f.ownerUserId ? (userNames.get(f.ownerUserId) ?? f.ownerUserId) : null),
        openTaskCount: (f) => f.openTaskCount,
        lastGiftDate: (f) => f.lastGiftDate,
        lastGiftAmount: (f) => (f.lastGiftAmount != null ? Number(f.lastGiftAmount) : null),
      }, ts.sort),
    [funders, ts.sort, userNames],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
          Top Priority Funders
          {!loading && (
            <span className="text-muted-foreground font-normal text-sm">({funders.length})</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="name" {...ts} className="pl-6">Funder</SortableTH>
              <SortableTH colKey="owner" {...ts} className="w-36">Owner</SortableTH>
              <TableHead>Open opportunities</TableHead>
              <SortableTH colKey="openTaskCount" {...ts} align="right" className="w-28">Open Tasks</SortableTH>
              <TableHead className="w-40">Affiliated People</TableHead>
              <SortableTH colKey="lastGiftDate" {...ts} align="right" className="w-28">Last Gift</SortableTH>
              <SortableTH colKey="lastGiftAmount" {...ts} align="right" className="w-28 pr-6">Last Gift $</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <SkeletonRows cols={7} />
            ) : funders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="pl-6 py-8 text-center text-muted-foreground">
                  No top-priority funders
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="pl-6">
                    <FunderNameCell funder={f} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {f.ownerUserId
                      ? (userNames.get(f.ownerUserId) ?? f.ownerUserId)
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <OpenAsksCell asks={f.openAsks ?? []} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {f.openTaskCount > 0 ? (
                      <span className="font-medium">{f.openTaskCount}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <AffiliatedPeopleCell people={f.affiliatedPeople ?? []} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {f.lastGiftDate ? formatDateShort(f.lastGiftDate) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums pr-6 text-sm">
                    {f.lastGiftAmount ? formatCurrency(f.lastGiftAmount) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function IndividualsTable({
  individuals,
  viewer,
  loading,
}: {
  individuals: TopPriorityPerson[];
  viewer: Viewer;
  loading: boolean;
}) {
  const ts = useTableState("top-priority-individuals", { key: "name" });
  const userNames = useUserNameMap();

  const sorted = useMemo(
    () =>
      sortRows(individuals, {
        name: (p) =>
          p.fullName ||
          [p.firstName, p.lastName].filter(Boolean).join(" ") ||
          p.id,
        owner: (p) => (p.ownerUserId ? (userNames.get(p.ownerUserId) ?? p.ownerUserId) : null),
        openTaskCount: (p) => p.openTaskCount,
        lastGiftDate: (p) => p.lastGiftDate,
        lastGiftAmount: (p) => (p.lastGiftAmount != null ? Number(p.lastGiftAmount) : null),
      }, ts.sort),
    [individuals, ts.sort, userNames],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
          Top Priority Individuals
          {!loading && (
            <span className="text-muted-foreground font-normal text-sm">({individuals.length})</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="name" {...ts} className="pl-6">Individual</SortableTH>
              <SortableTH colKey="owner" {...ts} className="w-36">Owner</SortableTH>
              <TableHead>Open opportunities</TableHead>
              <SortableTH colKey="openTaskCount" {...ts} align="right" className="w-28">Open Tasks</SortableTH>
              <SortableTH colKey="lastGiftDate" {...ts} align="right" className="w-28">Last Gift</SortableTH>
              <SortableTH colKey="lastGiftAmount" {...ts} align="right" className="w-28 pr-6">Last Gift $</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <SkeletonRows cols={6} />
            ) : individuals.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="pl-6 py-8 text-center text-muted-foreground">
                  No top-priority individuals
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-6">
                    <PersonNameCell person={p} viewer={viewer} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.ownerUserId
                      ? (userNames.get(p.ownerUserId) ?? p.ownerUserId)
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <OpenAsksCell asks={p.openAsks ?? []} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.openTaskCount > 0 ? (
                      <span className="font-medium">{p.openTaskCount}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {p.lastGiftDate ? formatDateShort(p.lastGiftDate) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums pr-6 text-sm">
                    {p.lastGiftAmount ? formatCurrency(p.lastGiftAmount) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function TopPrioritiesPage() {
  // Always revalidate when the user navigates back to this page (e.g. after
  // editing a record elsewhere) instead of serving the 60s-stale cache.
  const { data, isLoading } = useGetTopPriorities({
    query: { queryKey: getGetTopPrioritiesQueryKey(), refetchOnMount: "always" },
  });
  const { data: currentUser } = useGetCurrentUser();
  const viewer: Viewer = currentUser ?? null;

  const funders = data?.organizations ?? [];
  const individuals = data?.individuals ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Top Priorities</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Your most important funders and individuals in one place.
        </p>
      </div>

      <FundersTable funders={funders} viewer={viewer} loading={isLoading} />
      <IndividualsTable individuals={individuals} viewer={viewer} loading={isLoading} />
    </div>
  );
}
