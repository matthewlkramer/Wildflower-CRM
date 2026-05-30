import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type ListGiftsAndPaymentsParams,
  type ListOpportunitiesAndPledgesParams,
  type OpportunityStatus,
} from "@workspace/api-client-react";
import { GiftFormDialog } from "@/components/gift-form-dialog";
import { CreateOpportunityDialog } from "@/components/create-opportunity-dialog";
import { RelatedCard, RelatedRow } from "@/components/record-layout";
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
    <RelatedCard
      title="Gifts & payments"
      count={isLoading ? undefined : total}
      action={<GiftFormDialog scope={scope} />}
    >
      {isError ? (
        <p className="px-2 py-2 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load gifts."}
        </p>
      ) : isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No linked gifts.
        </p>
      ) : (
        <div data-testid="linked-gifts">
          {rows.map((g) => (
            <div key={g.id} data-testid={`row-linked-gift-${g.id}`}>
              <RelatedRow
                name={g.name ?? `Gift ${g.id}`}
                href={`/gifts/${g.id}`}
                tone="primary"
                sub={`${formatDateShort(g.dateReceived)} · ${formatEnum(g.type)}`}
                amount={formatCurrency(g.amount)}
              />
            </div>
          ))}
        </div>
      )}
    </RelatedCard>
  );
}

/**
 * Pledges card — uses the server's pledgeView filter (wasPledge=true OR
 * stage ∈ conditional/verbal/written) so historical pledges stay
 * visible after they're fully paid. Opportunities card uses the
 * complement. Shown as separate cards because fundraisers reason about
 * them differently (covered FYs vs still-being-negotiated ask amounts).
 */
export function LinkedOpportunitiesCard({
  scope,
  pledgeView,
  status,
  title,
  emptyLabel,
}: {
  scope: LinkedRecordsScope;
  /** Server-side page split. Omit to include all rows. */
  pledgeView?: "pledges" | "opportunities";
  /** Optional explicit status filter (rare; usually drive via pledgeView). */
  status?: OpportunityStatus;
  title: string;
  emptyLabel: string;
}) {
  const params: ListOpportunitiesAndPledgesParams = {
    ...buildBaseParams(scope),
    ...(pledgeView ? { pledgeView } : {}),
    ...(status ? { status: [status] } : {}),
    limit: PAGE_SIZE,
    page: 1,
  };
  const { data, isLoading, isError, error } = useListOpportunitiesAndPledges(
    params,
    { query: { queryKey: getListOpportunitiesAndPledgesQueryKey(params) } },
  );
  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const isPledgeView = pledgeView === "pledges";

  return (
    <RelatedCard
      title={title}
      count={isLoading ? undefined : total}
      action={
        <CreateOpportunityDialog
          scope={scope}
          mode={isPledgeView ? "pledge" : "opportunity"}
        />
      }
    >
      {isError ? (
        <p className="px-2 py-2 text-sm text-destructive">
          {error instanceof Error
            ? error.message
            : "Failed to load opportunities."}
        </p>
      ) : isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div data-testid="linked-opportunities">
          {rows.map((o) => {
            // Rows that belong on the Pledges page (wasPledge=true OR
            // stage ∈ pledge stages) link through /pledges so
            // breadcrumbs/back-links stay consistent with how the user
            // navigated in; everything else routes through /opportunities.
            const stageIsPledge =
              o.stage === "conditional_commitment" ||
              o.stage === "verbal_commitment" ||
              o.stage === "written_commitment";
            const href =
              o.wasPledge || stageIsPledge
                ? `/pledges/${o.id}`
                : `/opportunities/${o.id}`;
            const statusLabel = o.status ? formatEnum(o.status) : null;
            const fy = o.fiscalYear?.toUpperCase();
            const sub = [formatEnum(o.stage), statusLabel, fy]
              .filter(Boolean)
              .join(" · ");
            return (
              <div key={o.id} data-testid={`row-linked-opp-${o.id}`}>
                <RelatedRow
                  name={o.name ?? `Untitled ${o.id}`}
                  href={href}
                  tone="primary"
                  sub={sub}
                  amount={formatCurrency(
                    isPledgeView ? o.awardedAmount : o.askAmount,
                  )}
                />
              </div>
            );
          })}
        </div>
      )}
    </RelatedCard>
  );
}
