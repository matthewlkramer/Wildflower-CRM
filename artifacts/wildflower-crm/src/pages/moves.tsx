import { useMemo } from "react";
import { Link } from "wouter";
import { useListPeople } from "@workspace/api-client-react";
import { personDisplayName } from "@/lib/person";
import { formatDate } from "@/lib/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const FETCH_LIMIT = 200;

export default function Moves() {
  const { data, isLoading, isError, error } = useListPeople({
    deceased: false,
    limit: FETCH_LIMIT,
    page: 1,
  });

  const rows = useMemo(() => {
    const all = data?.data ?? [];
    // Oldest-contacted first; people never contacted bubble to the top.
    return all.slice().sort((a, b) => {
      if (a.lastContacted === b.lastContacted) return 0;
      if (!a.lastContacted) return -1;
      if (!b.lastContacted) return 1;
      return a.lastContacted.localeCompare(b.lastContacted);
    });
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Moves</h1>
        <p className="text-sm text-muted-foreground mt-1">
          People who could use a touch — ordered by oldest contact first.
          {data && data.pagination.total > FETCH_LIMIT ? (
            <span> Showing the first {FETCH_LIMIT} of {data.pagination.total.toLocaleString()}.</span>
          ) : null}
        </p>
      </div>

      <div className="rounded-md border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Last contacted</TableHead>
              <TableHead className="text-right">Interactions</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Region</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center h-24 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center h-24 text-destructive">
                  {error instanceof Error ? error.message : "Failed to load people."}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center h-24 text-muted-foreground">No people found.</TableCell></TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id} className="cursor-pointer hover:bg-muted/50 transition-colors" data-testid={`row-move-${p.id}`}>
                  <TableCell className="font-medium">
                    <Link href={`/individuals/${p.id}`} className="block w-full">
                      {personDisplayName(p)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {p.lastContacted ? formatDate(p.lastContacted) : (
                      <span className="text-muted-foreground italic">never</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{p.interactionCount ?? "—"}</TableCell>
                  <TableCell>{p.ownerUserId ?? "—"}</TableCell>
                  <TableCell>{p.currentHomeRegionId ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
