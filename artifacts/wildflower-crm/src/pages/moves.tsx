import { useListMoves, getListMovesQueryKey } from "@workspace/api-client-react";
import { formatEnum, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function Moves() {
  const { data, isLoading } = useListMoves(undefined, {
    query: {
      queryKey: getListMovesQueryKey()
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Moves Log</h1>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Donor</TableHead>
              <TableHead>Participants</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : data?.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No moves found.</TableCell>
              </TableRow>
            ) : (
              data?.data.map((move) => (
                <TableRow key={move.id} className="hover:bg-muted/50 transition-colors">
                  <TableCell>{formatDate(move.date)}</TableCell>
                  <TableCell className="font-medium">{move.subject}</TableCell>
                  <TableCell><Badge variant="secondary">{formatEnum(move.moveType)}</Badge></TableCell>
                  <TableCell>{move.individualName || move.householdName || move.fundingEntityName}</TableCell>
                  <TableCell>{move.participantUserNames.join(", ")}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
