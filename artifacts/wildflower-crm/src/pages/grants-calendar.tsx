import { useMemo } from "react";
import { Link } from "wouter";
import { useTableState, sortRows, SortableTH } from "@/lib/table-helpers";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledge,
} from "@workspace/api-client-react";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DonorCell } from "@/components/donor-cell";

const FETCH_LIMIT = 1000;
const QUERY_PARAMS = { status: "open" as const, limit: FETCH_LIMIT, page: 1 };

// Today's calendar date in Wildflower's booking timezone (America/Chicago),
// formatted as YYYY-MM-DD so it sorts/compares correctly against the
// date-only `applicationDeadline` / `projectedCloseDate` strings the API
// returns. Computed once per render — cheap, and avoids any UTC drift
// around midnight that would briefly hide today's deadlines.
function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default function GrantsCalendar() {
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(
    QUERY_PARAMS,
    { query: { queryKey: getListOpportunitiesAndPledgesQueryKey(QUERY_PARAMS) } },
  );

  const ts = useTableState("grants-calendar", { key: "applicationDeadline", dir: "asc" });
  const STAGE_ORDER: Record<string, number> = {
    cold_lead: 1, warm_lead: 2, in_conversation: 3, convince: 4,
    conditional_commitment: 5, probable_renewal: 6, verbal_commitment: 7,
    written_commitment: 8, cash_in: 9,
  };
  const upcoming = useMemo(() => {
    const rows = data?.data ?? [];
    const today = todayInChicago();
    return rows
      .map((o) => ({
        o,
        sortDate: o.applicationDeadline ?? o.projectedCloseDate ?? "",
      }))
      .filter(({ sortDate }) => sortDate && sortDate >= today)
      .sort((a, b) => a.sortDate.localeCompare(b.sortDate))
      .map(({ o }) => o);
  }, [data]);

  const sortedUpcoming = useMemo(
    () =>
      sortRows(
        upcoming,
        {
          applicationDeadline: (o) => o.applicationDeadline ?? null,
          projectedClose: (o) => o.projectedCloseDate ?? null,
          name: (o) => (o.name ?? "").toLowerCase(),
          funder: (o) =>
            (o.funderName ?? o.householdName ?? o.individualGiverPersonName ?? "").toLowerCase(),
          primaryContact: (o) => o.primaryContactPersonName?.toLowerCase() ?? null,
          stage: (o) => (o.stage ? (STAGE_ORDER[o.stage] ?? 0) : null),
          ask: (o) => (o.askAmount != null ? Number(o.askAmount) : null),
        },
        ts.sort,
      ),
    [upcoming, ts.sort],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Grants calendar</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open opportunities with an application deadline (or projected close) today or later, sorted soonest first.
          {data && data.pagination.total > FETCH_LIMIT ? (
            <span> Showing the first {FETCH_LIMIT} of {data.pagination.total.toLocaleString()}.</span>
          ) : null}
        </p>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTH colKey="applicationDeadline" {...ts}>Application deadline</SortableTH>
              <SortableTH colKey="projectedClose" {...ts}>Projected close</SortableTH>
              <SortableTH colKey="name" {...ts}>Name</SortableTH>
              <SortableTH colKey="funder" {...ts}>Funder</SortableTH>
              <SortableTH colKey="primaryContact" {...ts}>Primary contact</SortableTH>
              <SortableTH colKey="stage" {...ts}>Stage</SortableTH>
              <SortableTH colKey="ask" align="right" {...ts}>Ask</SortableTH>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : sortedUpcoming.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">No open opportunities with deadlines today or later.</TableCell></TableRow>
            ) : (
              sortedUpcoming.map((o: OpportunityOrPledge) => (
                <TableRow key={o.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-cal-${o.id}`}>
                  <TableCell>{formatDateShort(o.applicationDeadline)}</TableCell>
                  <TableCell>{formatDateShort(o.projectedCloseDate)}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/opportunities/${o.id}`} className="block w-full">
                      {o.name ?? `Untitled ${o.id}`}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DonorCell
                      funderId={o.funderId}
                      funderName={o.funderName}
                      householdId={o.householdId}
                      householdName={o.householdName}
                      individualGiverPersonId={o.individualGiverPersonId}
                      individualGiverPersonName={o.individualGiverPersonName}
                    />
                  </TableCell>
                  <TableCell>
                    {o.primaryContactPersonId ? (
                      <Link
                        href={`/individuals/${o.primaryContactPersonId}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {o.primaryContactPersonName ?? o.primaryContactPersonId}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{formatEnum(o.stage)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(o.askAmount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
