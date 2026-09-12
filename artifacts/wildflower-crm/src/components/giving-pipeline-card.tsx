import type { ReactNode } from "react";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  useGetGivingRelationship,
  getGetGivingRelationshipQueryKey,
  type DonorRecordKind,
  type GivingRelationship,
  type ListGiftsAndPaymentsParams,
  type ListOpportunitiesAndPledgesParams,
  type GiftOrPayment,
  type OpportunityOrPledge,
} from "@workspace/api-client-react";
import { RecordReceivedGiftDialog } from "@/components/record-received-gift-dialog";
import { CreateOpportunityDialog } from "@/components/create-opportunity-dialog";
import {
  buildBaseParams,
  type LinkedRecordsScope,
} from "@/components/linked-records";
import { RelatedCard, RelatedRow } from "@/components/record-layout";
import { groupGiving, type GivingThread } from "@/lib/giving-groups";
import { formatCurrency, formatDateShort, formatEnum } from "@/lib/format";
import { opportunityStatusLabel } from "@/lib/opportunity-status";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CircleDollarSign, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";

// Same per-card cap as the legacy linked-record cards; the header count
// still shows the true totals.
const PAGE_SIZE = 50;

/**
 * Single "Giving & pipeline" card that replaces the separate Open
 * opportunities / Pledges / Gifts & payments cards on donor detail pages
 * (record-v2 graduation). Sections: Open asks → Waiting for payment →
 * Past giving → Dormant / lost (muted, labeled — never hidden). Gifts are
 * nested under their source opportunity so a pledge and its payments read
 * as one thread.
 */
export function GivingPipelineCard({
  scope,
  relationship,
}: {
  scope: LinkedRecordsScope;
  relationship: { sourceKind: DonorRecordKind; sourceId: string };
}) {
  const oppParams: ListOpportunitiesAndPledgesParams = {
    ...buildBaseParams(scope),
    limit: PAGE_SIZE,
    page: 1,
  };
  const oppsQ = useListOpportunitiesAndPledges(oppParams, {
    query: { queryKey: getListOpportunitiesAndPledgesQueryKey(oppParams) },
  });
  const giftParams: ListGiftsAndPaymentsParams = {
    ...buildBaseParams(scope),
    limit: PAGE_SIZE,
    page: 1,
  };
  const giftsQ = useListGiftsAndPayments(giftParams, {
    query: { queryKey: getListGiftsAndPaymentsQueryKey(giftParams) },
  });
  const relationshipQueryKey = getGetGivingRelationshipQueryKey(
    relationship.sourceKind,
    relationship.sourceId,
  );
  const relationshipQ = useGetGivingRelationship(
    relationship.sourceKind,
    relationship.sourceId,
    { query: { queryKey: relationshipQueryKey } },
  );

  const isLoading =
    oppsQ.isLoading || giftsQ.isLoading || relationshipQ.isLoading;
  const isError = oppsQ.isError || giftsQ.isError;
  const error = oppsQ.error ?? giftsQ.error;
  const opps = oppsQ.data?.data ?? [];
  const gifts = giftsQ.data?.data ?? [];
  const givingRelationship = relationshipQ.data ?? null;
  const total =
    (oppsQ.data?.pagination.total ?? 0) + (giftsQ.data?.pagination.total ?? 0);

  const groups = groupGiving(opps, gifts);
  const isEmpty =
    groups.openAsks.length === 0 &&
    groups.waitingForPayment.length === 0 &&
    groups.pastGiving.length === 0 &&
    groups.dormantOrLost.length === 0;

  return (
    <RelatedCard
      title="Giving & pipeline"
      count={isLoading ? undefined : total}
      // This card is intentionally a discoverable work surface even when the
      // donor has no rows yet: the three creation actions remain available.
      empty={false}
      action={
        <div className="flex items-center gap-1">
          <CreateOpportunityDialog
            scope={scope}
            mode="opportunity"
            trigger={<Button size="sm" variant="ghost">Add opportunity</Button>}
          />
          <CreateOpportunityDialog
            scope={scope}
            mode="pledge"
            trigger={<Button size="sm" variant="ghost">Add pledge</Button>}
          />
          <RecordReceivedGiftDialog
            scope={scope}
            trigger={<Button size="sm" variant="ghost">Add gift</Button>}
          />
        </div>
      }
    >
      {isError ? (
        <p className="px-2 py-2 text-sm text-destructive">
          {error instanceof Error
            ? error.message
            : "Failed to load giving records."}
        </p>
      ) : isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div data-testid="giving-pipeline">
          {relationshipQ.isError ? (
            <p className="px-2 pb-3 text-sm text-destructive">
              The giving relationship summary could not be loaded.
            </p>
          ) : givingRelationship ? (
            <GivingRelationshipSummary data={givingRelationship} />
          ) : null}
          {isEmpty ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              No giving or pipeline records yet.
            </p>
          ) : null}
          <Section title="Open asks" show={groups.openAsks.length > 0}>
            {groups.openAsks.map((t) => (
              <OppThread key={t.opp.id} thread={t} amountField="ask" />
            ))}
          </Section>
          <Section
            title="Waiting for payment"
            show={groups.waitingForPayment.length > 0}
          >
            {groups.waitingForPayment.map((t) => (
              <OppThread key={t.opp.id} thread={t} amountField="awarded" />
            ))}
          </Section>
          <Section title="Past giving" show={groups.pastGiving.length > 0}>
            {groups.pastGiving.map((e) =>
              e.opp ? (
                <OppThread
                  key={e.opp.id}
                  thread={{ opp: e.opp, gifts: e.gifts }}
                  amountField="awarded"
                />
              ) : (
                e.gifts.map((g) => <GiftRow key={g.id} gift={g} />)
              ),
            )}
          </Section>
          <Section
            title="Dormant / lost"
            show={groups.dormantOrLost.length > 0}
          >
            {groups.dormantOrLost.map((t) => (
              <div key={t.opp.id} className="opacity-60">
                <OppThread thread={t} amountField="ask" />
              </div>
            ))}
          </Section>
        </div>
      )}
    </RelatedCard>
  );
}

function GivingRelationshipSummary({ data }: { data: GivingRelationship }) {
  return (
    <div className="mb-4" data-testid="giving-relationship-summary">
      <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Giving relationship
      </div>
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
            through an intermediary. This overlaps the relationship total; it is
            a delivery method, not additional giving.
          </div>
        ) : null}
      </div>

      {data.breakdown.length > 0 ? (
        <div>
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
      ) : null}
    </div>
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

function Section({
  title,
  show,
  children,
}: {
  title: string;
  show: boolean;
  children: ReactNode;
}) {
  if (!show) return null;
  return (
    <div className="mb-3 last:mb-0">
      <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Crossed-out dollar icon indicating unfunded/unlinked money. */
function UnfundedIcon({ tooltip }: { tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex h-3.5 w-3.5 shrink-0 cursor-default align-middle text-amber-600">
          <CircleDollarSign className="h-3.5 w-3.5" />
          <Ban className="absolute inset-0 h-3.5 w-3.5 opacity-80" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function OppThread({
  thread,
  amountField,
}: {
  thread: GivingThread<OpportunityOrPledge, GiftOrPayment>;
  amountField: "ask" | "awarded";
}) {
  const o = thread.opp;
  // Rows that belong on the Pledges page (writtenPledge=true) link through
  // /pledges so breadcrumbs stay consistent; everything else routes through
  // /opportunities — same rule as the legacy linked cards.
  const href = o.writtenPledge ? `/pledges/${o.id}` : `/opportunities/${o.id}`;
  const statusLabel = opportunityStatusLabel(o.status);
  const fy = o.fiscalYear?.toUpperCase();
  const sub = [formatEnum(o.stage), statusLabel, fy]
    .filter(Boolean)
    .join(" · ");

  // Show the unfunded icon on pledge rows with no payments yet.
  const unpaidPledge =
    o.status === "pledge" && (!o.paidAmount || parseFloat(o.paidAmount) === 0);

  return (
    <div data-testid={`row-giving-opp-${o.id}`}>
      <RelatedRow
        name={o.name ?? `Untitled ${o.id}`}
        href={href}
        tone="primary"
        sub={sub}
        amount={formatCurrency(
          amountField === "awarded" ? o.awardedAmount : o.askAmount,
        )}
        badge={
          unpaidPledge ? (
            <UnfundedIcon tooltip="No payments recorded yet" />
          ) : undefined
        }
      />
      {thread.gifts.length > 0 ? (
        <div className="ml-3 border-l-2 border-muted pl-2">
          {thread.gifts.map((g) => (
            <GiftRow key={g.id} gift={g} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GiftRow({ gift: g }: { gift: GiftOrPayment }) {
  // Suppress the type label when it's the default (standard_gift).
  const typeLabel =
    g.type && g.type !== "standard_gift" ? formatEnum(g.type) : null;
  const sub = [formatDateShort(g.dateReceived), typeLabel]
    .filter(Boolean)
    .join(" · ");

  // Show the unfunded icon for on-books gifts with no QuickBooks record yet.
  const unlinked = !g.offBooks && g.quickbooksTieStatus === "missing";

  return (
    <div data-testid={`row-giving-gift-${g.id}`}>
      <RelatedRow
        name={g.name ?? `Gift ${g.id}`}
        href={`/gifts/${g.id}`}
        tone="primary"
        sub={sub}
        amount={formatCurrency(g.amount)}
        badge={
          unlinked ? (
            <UnfundedIcon tooltip="Not yet linked to a QuickBooks record" />
          ) : undefined
        }
      />
    </div>
  );
}
