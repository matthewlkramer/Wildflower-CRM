import { useListHouseholds, getListHouseholdsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatCurrency, formatDate, formatCapacity } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Households() {
  const { data, isLoading } = useListHouseholds(undefined, {
    query: {
      queryKey: getListHouseholdsQueryKey()
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Households</h1>
        <Link href="/households/new" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
          Add Household
        </Link>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Capacity</TableHead>
              <TableHead>Last Activity</TableHead>
              <TableHead className="text-right">Total Giving</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : data?.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No households found.</TableCell>
              </TableRow>
            ) : (
              data?.data.map((household) => (
                <TableRow key={household.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <TableCell className="font-medium">
                    <Link href={`/households/${household.id}`} className="block w-full">
                      {household.name}
                    </Link>
                  </TableCell>
                  <TableCell>{household.memberCount}</TableCell>
                  <TableCell>{formatCapacity(household.capacityRating)}</TableCell>
                  <TableCell>{formatDate(household.lastActivityDate)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(household.totalGiving)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
