import { useListFundingEntities, getListFundingEntitiesQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function FundingEntities() {
  const { data, isLoading } = useListFundingEntities(undefined, {
    query: {
      queryKey: getListFundingEntitiesQueryKey()
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-serif font-bold text-foreground">Funding Entities</h1>
        <Link href="/funding-entities/new" className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
          Add Entity
        </Link>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Last Gift Date</TableHead>
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
                <TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No entities found.</TableCell>
              </TableRow>
            ) : (
              data?.data.map((entity) => (
                <TableRow key={entity.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <TableCell className="font-medium">
                    <Link href={`/funding-entities/${entity.id}`} className="block w-full">
                      {entity.legalName}
                    </Link>
                  </TableCell>
                  <TableCell>{formatEnum(entity.subtype)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{formatEnum(entity.institutionalCultivationStage || entity.governmentCultivationStage)}</Badge>
                  </TableCell>
                  <TableCell>{formatDate(entity.lastGiftDate)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(entity.totalGiving)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
