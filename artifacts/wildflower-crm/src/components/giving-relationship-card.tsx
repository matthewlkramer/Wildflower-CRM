import {
  getGetGivingRelationshipQueryKey,
  useGetGivingRelationship,
  type DonorRecordKind,
} from "@workspace/api-client-react";
import { RelatedCard, RelatedRow } from "@/components/record-layout";
import { formatCurrency, formatDateShort } from "@/lib/format";

export function GivingRelationshipCard({
  sourceKind,
  sourceId,
}: {
  sourceKind: DonorRecordKind;
  sourceId: string;
}) {
  const queryKey = getGetGivingRelationshipQueryKey(sourceKind, sourceId);
  const query = useGetGivingRelationship(sourceKind, sourceId, {
    query: { queryKey },
  });
  const data = query.data ?? null;

  return (
    <RelatedCard
      title="Giving relationship"
      count={data?.giftCount}
      empty={!query.isLoading && !query.isError && data?.giftCount === 0}
    >
      {query.isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : query.isError || !data ? (
        <p className="px-2 py-2 text-sm text-destructive">
          {query.error instanceof Error
            ? query.error.message
            : "Failed to load giving relationship."}
        </p>
      ) : (
        <div data-testid={`giving-relationship-${sourceKind}-${sourceId}`}>
          <div className="grid grid-cols-2 gap-2 px-2 pb-3">
            <Metric
              label="Relationship total"
              value={formatCurrency(data.relationshipTotal)}
              emphasized
            />
            <Metric
              label="Donor of record"
              value={formatCurrency(data.donorOfRecordTotal)}
            />
            <Metric label="Gifts" value={String(data.giftCount)} />
            <Metric
              label="Largest gift"
              value={formatCurrency(data.largestGift?.amount)}
            />
          </div>

          <div className="mx-2 mb-3 rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="font-medium text-foreground">
              {data.requiresDecision
                ? "Choose the donor each time"
                : data.resolvedDonor
                  ? `New gifts route to ${data.resolvedDonor.name}`
                  : "No resolved donor pathway"}
            </div>
            {data.throughIntermediaryTotal !== "0.00" ? (
              <div className="mt-1 text-muted-foreground">
                {formatCurrency(data.throughIntermediaryTotal)} was delivered
                through an intermediary. This overlaps the relationship total;
                it is a delivery method, not additional giving.
              </div>
            ) : null}
          </div>

          <div className="mb-3">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Attribution breakdown
            </div>
            {data.breakdown.map((item) => (
              <div
                key={item.kind}
                className="flex items-start justify-between gap-3 px-2 py-1.5 text-sm"
                title={item.description}
              >
                <div className="min-w-0">
                  <div className="font-medium">{item.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.giftCount} {item.giftCount === 1 ? "gift" : "gifts"}
                  </div>
                </div>
                <div className="shrink-0 tabular-nums font-medium">
                  {formatCurrency(item.amount)}
                </div>
              </div>
            ))}
          </div>

          {data.recentGifts.length > 0 ? (
            <div>
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent gifts
              </div>
              {data.recentGifts.slice(0, 6).map((gift) => {
                const sub = [
                  formatDateShort(gift.dateReceived),
                  gift.attributionLabel,
                  gift.paymentIntermediary
                    ? `via ${gift.paymentIntermediary.name}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <RelatedRow
                    key={gift.id}
                    name={gift.name ?? gift.donor.name}
                    href={`/gifts/${gift.id}`}
                    tone="primary"
                    sub={sub}
                    amount={formatCurrency(gift.amount)}
                  />
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              No giving records yet.
            </p>
          )}
        </div>
      )}
    </RelatedCard>
  );
}

function Metric({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={
          emphasized
            ? "mt-1 text-lg font-semibold tabular-nums"
            : "mt-1 text-sm font-semibold tabular-nums"
        }
      >
        {value}
      </div>
    </div>
  );
}
