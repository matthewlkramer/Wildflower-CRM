import type { ReactNode } from "react";
import {
  useListGiftsAndPayments,
  getListGiftsAndPaymentsQueryKey,
  useListOpportunitiesAndPledges,
  getListOpportunitiesAndPledgesQueryKey,
  type ListGiftsAndPaymentsParams,
  type ListOpportunitiesAndPledgesParams,
  type GiftOrPayment,
  type OpportunityOrPledge,
} from "@workspace/api-client-react";
import { GiftFormDialog } from "@/components/gift-form-dialog";
import { CreateOpportunityDialog } from "@/components/create-opportunity-dialog";
import {
  buildBaseParams,
  type LinkedRecordsScope,
} from "@/components/linked-records";
import { RelatedCard, RelatedRow } from "@/components/record-layout";
import { groupGiving, type GivingThread } from "@/lib/giving-groups";
import {
  formatCurrency,
  formatDateShort,
  formatEnum,
} from "@/lib/format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CircleDollarSign, Ban } from "lucide-react";

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
export function GivingPipelineCard({ scope }: { scope: LinkedRecordsScope }) {
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

  const isLoading = oppsQ.isLoading || giftsQ.isLoading;
  const isError = oppsQ.isError || giftsQ.isError;
  const error = oppsQ.error ?? giftsQ.error;
  const opps = oppsQ.data?.data ?? [];
  const gifts = giftsQ.data?.data ?? [];
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
      action={
        <div className="flex items-center gap-1">
          <CreateOpportunityDialog scope={scope} mode="opportunity" />
          <CreateOpportunityDialog scope={scope} mode="pledge" />
          <GiftFormDialog scope={scope} />
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
      ) : isEmpty ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No giving or pipeline records yet.
        </p>
      ) : (
        <div data-testid="giving-pipeline">
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
  const statusLabel = o.status
    ? o.status === "pledge"
      ? "Waiting for payment"
      : formatEnum(o.status)
    : null;
  const fy = o.fiscalYear?.toUpperCase();
  const sub = [formatEnum(o.stage), statusLabel, fy].filter(Boolean).join(" · ");

  // Show the unfunded icon on pledge rows with no payments yet.
  const unpaidPledge =
    o.status === "pledge" &&
    (!o.paidAmount || parseFloat(o.paidAmount) === 0);

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
