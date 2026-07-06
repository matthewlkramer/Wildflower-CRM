import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListIncompleteGifts,
  useListEntities,
  getListEntitiesQueryKey,
  type IncompleteGift,
  type ListIncompleteGiftsParams,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebounce } from "@/hooks/use-debounce";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { ArrowRight } from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────
 * Incomplete-gift-record worklist — the "bookable-gift SOP" report.
 *
 * One row PER gift that fails the bookable-gift standard: it is on-books
 * (not exempt) yet still lacks a piece of critical coding info needed to
 * book it — a donor, an amount/date, an allocation, an allocation's entity /
 * fiscal year / intended usage / fundable project, restriction evidence for a
 * donor-restricted gift, or a reporting-deadline task for a report-required
 * grant. Every failing checklist item is shown as a badge so the reviewer
 * knows exactly what to fix. This is a data-quality queue, not a money queue:
 * there is no reconcile/link action here — the reviewer opens the gift and
 * fills in what's missing.
 * ──────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;
const ANY = "__any__";

export function IncompleteGiftsWorklist() {
  const [search, setSearch] = useState("");
  const [entityId, setEntityId] = useState<string>(ANY);
  const [page, setPage] = useState(0);

  const debouncedSearch = useDebounce(search.trim());

  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const entities = entitiesQ.data ?? [];

  // Reset paging whenever any filter changes.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, entityId]);

  const params = useMemo<ListIncompleteGiftsParams>(() => {
    const p: ListIncompleteGiftsParams = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (debouncedSearch) p.q = debouncedSearch;
    if (entityId !== ANY) p.entityId = entityId;
    return p;
  }, [debouncedSearch, entityId, page]);

  const { data, isLoading, isError } = useListIncompleteGifts(params);

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search donor name…"
          className="h-9"
          data-testid="incomplete-gifts-search"
        />
        <Select value={entityId} onValueChange={setEntityId}>
          <SelectTrigger className="h-9" data-testid="incomplete-gifts-entity">
            <SelectValue placeholder="Entity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All entities</SelectItem>
            {entities.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading gifts…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          Couldn't load incomplete gifts.
        </p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No incomplete gift records for these filters — every on-books gift
            has the coding info it needs to be booked.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((g) => (
            <IncompleteGiftCard key={g.id} g={g} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Showing {showingFrom}–{showingTo} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              data-testid="incomplete-gifts-prev"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={showingTo >= total}
              onClick={() => setPage((p) => p + 1)}
              data-testid="incomplete-gifts-next"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function IncompleteGiftCard({ g }: { g: IncompleteGift }) {
  const recordLabel = g.giftName?.trim()
    ? g.giftName
    : `Gift ${g.id.slice(0, 8)}`;
  const amountText = g.amount != null ? formatCurrency(g.amount) : null;
  const labels =
    g.reasonLabels && g.reasonLabels.length === g.reasons.length
      ? g.reasonLabels
      : g.reasons;

  return (
    <div
      className="rounded-lg border bg-card shadow-sm"
      data-testid={`incomplete-gift-${g.id}`}
    >
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 break-words">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            CRM gift
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/gifts/${g.id}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {recordLabel}
            </Link>
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {amountText ?? (
              <span className="text-sm font-normal text-muted-foreground">
                No amount recorded
              </span>
            )}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <div>{g.donorName ?? "No donor"}</div>
            <div>
              {g.dateReceived != null
                ? formatDateShort(g.dateReceived)
                : "No date recorded"}
            </div>
            {g.opportunityId && (
              <div>
                <Link
                  href={`/opportunities/${g.opportunityId}`}
                  className="underline-offset-2 hover:underline"
                >
                  {g.opportunityName ?? "Linked opportunity"}
                </Link>
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {labels.map((label, i) => (
              <Badge
                key={g.reasons[i]}
                variant="outline"
                className="border-amber-300 bg-amber-50 text-amber-700"
                data-testid={`incomplete-gift-reason-${g.reasons[i]}`}
              >
                {label}
              </Badge>
            ))}
          </div>
        </div>
        <div className="shrink-0">
          <Button asChild size="sm" variant="outline">
            <Link href={`/gifts/${g.id}`} data-testid={`incomplete-gift-fix-${g.id}`}>
              Fix
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
