import { useListIndividuals, getListIndividualsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatCurrency, formatDate, formatEnum, formatCapacity } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function Individuals() {
  const { data, isLoading } = useListIndividuals(undefined, {
    query: {
      queryKey: getListIndividualsQueryKey()
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Individuals</h1>
        <Link href="/individuals/new" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
          Add Individual
        </Link>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Enthusiasm</TableHead>
              <TableHead>Capacity</TableHead>
              <TableHead>Last Move</TableHead>
              <TableHead className="text-right">Total Giving</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : data?.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24 text-muted-foreground">No individuals found.</TableCell>
              </TableRow>
            ) : (
              data?.data.map((ind) => (
                <TableRow key={ind.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <TableCell className="font-medium">
                    <Link href={`/individuals/${ind.id}`} className="block w-full">
                      {ind.firstName} {ind.lastName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{formatEnum(ind.donorCultivationStage)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{formatEnum(ind.enthusiasm)}</Badge>
                  </TableCell>
                  <TableCell>{formatCapacity(ind.capacityRating)}</TableCell>
                  <TableCell>{formatDate(ind.lastMoveDate)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(ind.totalGiving)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
