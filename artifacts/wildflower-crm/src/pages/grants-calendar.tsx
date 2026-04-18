import { useGetGrantsCalendar, getGetGrantsCalendarQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function GrantsCalendar() {
  const { data, isLoading } = useGetGrantsCalendar(undefined, {
    query: {
      queryKey: getGetGrantsCalendarQueryKey(),
    },
  });

  const entries = Array.isArray(data) ? data : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Grants Calendar</h1>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Opportunity</TableHead>
              <TableHead>Funder</TableHead>
              <TableHead>LOI Deadline</TableHead>
              <TableHead>Proposal Deadline</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Requested</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">
                  No upcoming grant deadlines.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => {
                const daysUntil = entry.daysUntilNextDeadline;
                const isUrgent = daysUntil != null && daysUntil <= 14;
                return (
                  <TableRow
                    key={entry.opportunityId}
                    className="hover:bg-muted/50 transition-colors"
                    data-testid={`row-grant-${entry.opportunityId}`}
                  >
                    <TableCell className="font-medium">{entry.opportunityName ?? "—"}</TableCell>
                    <TableCell>{entry.donorName}</TableCell>
                    <TableCell>
                      {entry.loiDeadline ? (
                        <span className={entry.loiSubmitted ? "line-through text-muted-foreground" : ""}>
                          {formatDate(entry.loiDeadline)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {entry.proposalDeadline ? (
                          <>
                            <span className={isUrgent && !entry.proposalSubmitted ? "text-destructive font-medium" : ""}>
                              {formatDate(entry.proposalDeadline)}
                            </span>
                            {isUrgent && !entry.proposalSubmitted && (
                              <Badge variant="destructive" className="text-[10px] h-4 px-1">
                                {daysUntil === 0 ? "Today" : `${daysUntil}d`}
                              </Badge>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {entry.stage ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {entry.amountRequested != null ? formatCurrency(entry.amountRequested) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
