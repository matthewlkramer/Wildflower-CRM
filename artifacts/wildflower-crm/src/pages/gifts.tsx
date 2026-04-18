import { useListGifts, getListGiftsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatCurrency, formatFund, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function Gifts() {
  const { data, isLoading } = useListGifts(undefined, {
    query: {
      queryKey: getListGiftsQueryKey()
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Gifts Ledger</h1>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Donor</TableHead>
              <TableHead>Funds (allocated)</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : data?.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No gifts found.</TableCell>
              </TableRow>
            ) : (
              data?.data.map((gift) => {
                const allocFunds = (gift.allocations ?? [])
                  .map((a) => formatFund(a.fund))
                  .join(", ");
                return (
                  <TableRow key={gift.id} className="hover:bg-muted/50 transition-colors">
                    <TableCell className="font-medium">
                      <Link href={`/gifts/${gift.id}`} className="hover:underline">
                        {gift.donorName ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{allocFunds || "—"}</TableCell>
                    <TableCell>{formatDate(gift.cashReceivedDate)}</TableCell>
                    <TableCell>
                      {gift.reconciled ? (
                        <Badge variant="outline" className="bg-primary/10 text-primary">Reconciled</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium text-primary">{formatCurrency(gift.amount)}</TableCell>
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
