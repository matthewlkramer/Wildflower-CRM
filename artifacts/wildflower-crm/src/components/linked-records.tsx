import { Link } from "wouter";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type ListGiftsAndPaymentsParams,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityStatus,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";

// Cap each card at this many rows. Donor-scoped lists rarely exceed
// this in practice; the header still shows the true total. We do not
// render a "See all" link today because the index pages (gifts.tsx,
// opportunities.tsx) don't yet read filters from the URL, so any link
// here would lose the donor scope and silently mislead.
// TODO(detail-filters): once the index pages hydrate filters from the
// URL, add a "See all" link that serializes scope + status.
const PAGE_SIZE = 50;

/**
 * Donor-scoping filter for the linked-record cards. Exactly one of
 * the three fields must be set; the cards mirror the donor XOR
 * invariant from the DB / API so we never accidentally union three
 * unrelated donor's lists into one card.
 */
export type LinkedRecordsScope =
  | { funderId: string }
  | { householdId: string }
  | { individualGiverPersonId: string };

function buildBaseParams(scope: LinkedRecordsScope) {
  if ("funderId" in scope) return { funderId: scope.funderId };
  if ("householdId" in scope) return { householdId: scope.householdId };
  return { individualGiverPersonId: scope.individualGiverPersonId };
}

export function LinkedGiftsCard({ scope }: { scope: LinkedRecordsScope }) {
  const params: ListGiftsAndPaymentsParams = {
    ...buildBaseParams(scope),
    limit: PAGE_SIZE,
    page: 1,
  };
  const { data, isLoading, isError, error } = useListGiftsAndPayments(params, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(params) },
  });
  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Gifts &amp; payments</CardTitle>
        <span className="text-xs text-muted-foreground">
          {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {isError ? (
          <p className="text-sm text-destructive p-4">
            {error instanceof Error ? error.message : "Failed to load gifts."}
          </p>
        ) : isLoading ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">No linked gifts.</p>
        ) : (
          <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <TableRow
                    key={g.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    data-testid={`row-linked-gift-${g.id}`}
                  >
                    <TableCell className="font-medium">
                      <Link href={`/gifts/${g.id}`} className="block w-full">
                        {g.name ?? `Gift ${g.id}`}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateShort(g.dateReceived)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatEnum(g.type)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(g.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Pledges = opportunities with status='won', shown as a separate card
 * because fundraisers reason about them differently (covered FYs vs
 * still-being-negotiated ask amounts).
 */
export function LinkedOpportunitiesCard({
  scope,
  status,
  title,
  emptyLabel,
}: {
  scope: LinkedRecordsScope;
  /** Optional status filter — omit to show all (open + won + dormant + lost). */
  status?: OpportunityStatus;
  title: string;
  emptyLabel: string;
}) {
  const params: ListOpportunitiesAndPledgesParams = {
    ...buildBaseParams(scope),
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    page: 1,
  };
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(
    params,
    { query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) } },
  );
  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const isPledgeView = status === "won";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{title}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {isLoading ? "Loading…" : `${total.toLocaleString()} total`}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {isError ? (
          <p className="text-sm text-destructive p-4">
            {error instanceof Error
              ? error.message
              : "Failed to load opportunities."}
          </p>
        ) : isLoading ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4">{emptyLabel}</p>
        ) : (
          <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Status</TableHead>
                  {isPledgeView ? (
                    <TableHead className="text-right">Awarded</TableHead>
                  ) : (
                    <TableHead className="text-right">Ask</TableHead>
                  )}
                  <TableHead>FY</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => {
                  // Pledges (won) link through the /pledges shell so
                  // breadcrumbs/back-links stay consistent with how the
                  // user navigated in; everything else routes through
                  // /opportunities.
                  const href =
                    o.status === "won"
                      ? `/pledges/${o.id}`
                      : `/opportunities/${o.id}`;
                  return (
                    <TableRow
                      key={o.id}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      data-testid={`row-linked-opp-${o.id}`}
                    >
                      <TableCell className="font-medium">
                        <Link href={href} className="block w-full">
                          {o.name ?? `Untitled ${o.id}`}
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatEnum(o.stage)}
                      </TableCell>
                      <TableCell>
                        {o.status ? (
                          <Badge
                            variant={
                              o.status === "won" ? "default" : "outline"
                            }
                          >
                            {formatEnum(o.status)}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(
                          isPledgeView ? o.awardedAmount : o.askAmount,
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {o.fiscalYear?.toUpperCase() ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
        )}
      </CardContent>
    </Card>
  );
}
