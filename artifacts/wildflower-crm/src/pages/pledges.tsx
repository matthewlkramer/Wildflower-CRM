import { useListPledges, getListPledgesQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatCurrency, formatFund, formatEnum, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function Pledges() {
  const { data, isLoading } = useListPledges(undefined, {
    query: {
      queryKey: getListPledgesQueryKey()
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Pledges</h1>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Donor</TableHead>
              <TableHead>Fund</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next Installment</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : data?.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">No pledges found.</TableCell>
              </TableRow>
            ) : (
              data?.data.map((pledge) => (
                <TableRow key={pledge.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <TableCell className="font-medium">
                    <Link href={`/pledges/${pledge.id}`} className="block w-full">
                      {pledge.donorName}
                    </Link>
                  </TableCell>
                  <TableCell>{formatFund(pledge.fund)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{formatEnum(pledge.status)}</Badge>
                  </TableCell>
                  <TableCell>{formatDate(pledge.nextInstallmentDate)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(pledge.totalCommittedAmount)}</TableCell>
                  <TableCell className="text-right font-medium text-destructive">{formatCurrency(pledge.remainingAmount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
