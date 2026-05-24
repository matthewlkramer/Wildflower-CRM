import { useMemo } from "react";
import { Link } from "wouter";
import {
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type OpportunityOrPledge,
} from "@workspace/api-client-react";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const FETCH_LIMIT = 1000;
const QUERY_PARAMS = { status: "open" as const, limit: FETCH_LIMIT, page: 1 };

export default function GrantsCalendar() {
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(
    QUERY_PARAMS,
    { query: { queryKey: getListOpportunitiesAndPledgesQueryKey(QUERY_PARAMS) } },
  );

  const upcoming = useMemo(() => {
    const rows = data?.data ?? [];
    return rows
      .filter((o) => o.applicationDeadline || o.projectedCloseDate)
      .slice()
      .sort((a, b) => {
        const ad = a.applicationDeadline ?? a.projectedCloseDate ?? "";
        const bd = b.applicationDeadline ?? b.projectedCloseDate ?? "";
        return ad.localeCompare(bd);
      });
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Grants calendar</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open opportunities sorted by upcoming deadline.
          {data && data.pagination.total > FETCH_LIMIT ? (
            <span> Showing the first {FETCH_LIMIT} of {data.pagination.total.toLocaleString()}.</span>
          ) : null}
        </p>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Application deadline</TableHead>
              <TableHead>Projected close</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Ask</TableHead>
              <TableHead className="text-right">Awarded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load opportunities."}
                </TableCell>
              </TableRow>
            ) : upcoming.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center h-24 text-muted-foreground">No open opportunities with deadlines.</TableCell></TableRow>
            ) : (
              upcoming.map((o: OpportunityOrPledge) => (
                <TableRow key={o.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-cal-${o.id}`}>
                  <TableCell>{formatDate(o.applicationDeadline)}</TableCell>
                  <TableCell>{formatDate(o.projectedCloseDate)}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/opportunities/${o.id}`} className="block w-full">
                      {o.name ?? `Untitled ${o.id}`}
                    </Link>
                  </TableCell>
                  <TableCell>{formatEnum(o.stage)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(o.askAmount)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(o.awardedAmount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
