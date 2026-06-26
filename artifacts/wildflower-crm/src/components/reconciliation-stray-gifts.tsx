import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useListGiftsMissingQb,
  useListEntities,
  getListEntitiesQueryKey,
  GiftPaymentMethod,
  type ListGiftsMissingQbParams,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebounce } from "@/hooks/use-debounce";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";

/* ────────────────────────────────────────────────────────────────────────
 * Worklist 3 of 3 — "Gifts missing a QuickBooks record".
 *
 * Surfaces only gifts that are GENUINELY un-reconciled with QuickBooks so they
 * can be investigated. Gifts that are not expected to carry a per-gift QB record
 * are excluded server-side, so nothing here reads as unreconciled when it isn't:
 * off-books / fiscal-sponsor / designated-to-school gifts (exempt), and
 * Stripe-sourced gifts (the money lands in QuickBooks at the payout level).
 *
 * The "Recorded method" column is the donor's stated payment method on the gift
 * (check, DAF, etc.) — it is NOT a found payment match. Read-only — deep-link to
 * the gift to act.
 * ──────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 50;

const PAYMENT_METHODS: GiftPaymentMethod[] = [
  "ach",
  "check",
  "wire",
  "stock",
  "donor_box",
  "daf_ach",
  "daf_check",
  "daf_bill_com",
];

const ANY = "__any__";

export function StrayGiftsWorklist() {
  const [search, setSearch] = useState("");
  const [entityId, setEntityId] = useState<string>(ANY);
  const [paymentMethod, setPaymentMethod] = useState<string>(ANY);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);

  const debouncedSearch = useDebounce(search.trim());

  const entitiesQ = useListEntities({
    query: { queryKey: getListEntitiesQueryKey(), staleTime: 5 * 60_000 },
  });
  const entities = entitiesQ.data ?? [];

  // Reset paging whenever any filter changes.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, entityId, paymentMethod, dateFrom, dateTo]);

  const params = useMemo<ListGiftsMissingQbParams>(() => {
    const p: ListGiftsMissingQbParams = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (debouncedSearch) p.q = debouncedSearch;
    if (entityId !== ANY) p.entityId = entityId;
    if (paymentMethod !== ANY) p.paymentMethod = paymentMethod as GiftPaymentMethod;
    if (dateFrom) p.dateFrom = dateFrom;
    if (dateTo) p.dateTo = dateTo;
    return p;
  }, [debouncedSearch, entityId, paymentMethod, dateFrom, dateTo, page]);

  const { data, isLoading, isError } = useListGiftsMissingQb(params);

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search donor name…"
          className="h-9"
          data-testid="stray-gifts-search"
        />
        <Select value={entityId} onValueChange={setEntityId}>
          <SelectTrigger className="h-9" data-testid="stray-gifts-entity">
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
        <Select value={paymentMethod} onValueChange={setPaymentMethod}>
          <SelectTrigger className="h-9" data-testid="stray-gifts-method">
            <SelectValue placeholder="Payment method" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All methods</SelectItem>
            {PAYMENT_METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {formatEnum(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-9"
          aria-label="Date from"
          data-testid="stray-gifts-date-from"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-9"
          aria-label="Date to"
          data-testid="stray-gifts-date-to"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading gifts…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Couldn't load gifts.</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No gifts missing a QuickBooks record for these filters.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Donor</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Recorded method</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => (
                <TableRow key={g.id} data-testid={`stray-gift-${g.id}`}>
                  <TableCell>
                    <Link
                      href={`/gifts/${g.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {g.donorName ?? "—"}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {g.displayAmount != null ? (
                      formatCurrency(g.displayAmount)
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        No amount recorded
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {g.displayDate != null ? (
                      formatDateShort(g.displayDate)
                    ) : (
                      <span className="text-xs">No date recorded</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {g.paymentMethod ? formatEnum(g.paymentMethod) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {g.entityName ?? "—"}
                  </TableCell>
                  <TableCell>
                    {g.finalAmountSource ? formatEnum(g.finalAmountSource) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
              data-testid="stray-gifts-prev"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={showingTo >= total}
              onClick={() => setPage((p) => p + 1)}
              data-testid="stray-gifts-next"
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
