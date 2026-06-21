import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import {
  useGetReconciliationGraph,
  getGetReconciliationGraphQueryKey,
  type ReconciliationCard as ReconciliationCardType,
  type ReconciliationCandidate,
  type ReconciliationGraph,
  type ReconciliationMatchNodeType,
  type ApproveCompleteMatchBody,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatCurrency, formatDate } from "@/lib/format";
import { ReconciliationNodeTypeahead } from "@/components/reconciliation-node-typeahead";
import {
  FINAL_AMOUNT_SOURCE_LABEL,
  deriveApproveBody,
  giftToPledgeStatus,
  hasAmountBlocker,
  qbToGiftStatus,
  stripeToQbStatus,
  laneBadges,
  type ConnectionStatus,
  type OutcomeChoice,
} from "@/lib/reconciliation";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm tabular-nums">{value}</div>
    </div>
  );
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <Badge variant={status.variant} className="px-1.5 py-0 text-[10px]">
      {status.label}
    </Badge>
  );
}

/**
 * One connection between two records (e.g. "QuickBooks → Gift"), with the name
 * of the connected record and the connection's status. This is the core mental
 * model of a card: a chain of connections, not a bag of independent boxes.
 */
function ConnectionRow({
  from,
  to,
  status,
  name,
  href,
  context,
  testId,
}: {
  from: string;
  to: string;
  status: ConnectionStatus;
  name?: string | null;
  href?: string;
  context?: string | null;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
      data-testid={testId}
    >
      <span className="whitespace-nowrap text-muted-foreground">
        {from} <span className="text-muted-foreground/50">→</span> {to}
      </span>
      {name ? (
        href ? (
          <Link
            href={href}
            className="truncate font-medium underline-offset-2 hover:underline"
          >
            {name}
          </Link>
        ) : (
          <span className="truncate font-medium">{name}</span>
        )
      ) : null}
      {context ? (
        <span className="truncate text-xs text-muted-foreground">{context}</span>
      ) : null}
      <ConnectionBadge status={status} />
    </div>
  );
}

/** A labelled "↓ A → B [status]" divider between two stacked record cards. */
function ConnectionLink({
  from,
  to,
  status,
  testId,
}: {
  from: string;
  to: string;
  status?: ConnectionStatus | null;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 pl-1 text-xs text-muted-foreground"
      data-testid={testId}
    >
      <ArrowDown className="h-3 w-3 shrink-0" />
      <span>
        {from} <span className="text-muted-foreground/50">→</span> {to}
      </span>
      {status ? (
        <ConnectionBadge status={status} />
      ) : (
        <span className="text-muted-foreground/70">optional</span>
      )}
    </div>
  );
}

export function ReconciliationCard({
  card,
  expanded,
  onToggle,
  busy,
  onApprove,
}: {
  card: ReconciliationCardType;
  expanded: boolean;
  onToggle: () => void;
  busy: boolean;
  onApprove: (body: ApproveCompleteMatchBody) => Promise<unknown>;
}) {
  const isReconciled = card.status === "reconciled";

  // Reframe the card around the CONNECTIONS the reviewer reasons about, not the
  // individual records: Stripe → QuickBooks (does the charge tie to the
  // deposit?), QuickBooks → Gift (is the deposit booked to a gift?), and
  // optionally Gift → Pledge.
  const stripeConn = card.hasStripeEvidence
    ? stripeToQbStatus(card.stripeReconciliationStatus)
    : null;
  const qbGiftConn = qbToGiftStatus({
    stagedStatus: card.status,
    giftState: card.giftState,
  });
  const pledgeConn = giftToPledgeStatus(card.opportunityState);

  const giftName = isReconciled
    ? card.resolvedGiftName || card.resolvedGiftId
    : card.proposedGiftName;
  const giftHref =
    isReconciled && card.resolvedGiftId
      ? `/gifts/${card.resolvedGiftId}`
      : undefined;
  const donorContext = card.proposedDonorName
    ? `for ${card.proposedDonorName}`
    : null;

  return (
    <Card data-testid={`reconciliation-card-${card.stagedPaymentId}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold tabular-nums">
                {formatCurrency(card.amount)}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatDate(card.dateReceived)}
              </span>
              {card.payerName ? (
                <span className="truncate text-sm">{card.payerName}</span>
              ) : null}
              {card.entityName ? (
                <Badge variant="outline" className="text-[10px]">
                  {card.entityName}
                </Badge>
              ) : null}
              {card.hasStripeEvidence ? (
                <Badge variant="secondary" className="text-[10px]">
                  Stripe ·{" "}
                  {card.stripeChargeCount === 1
                    ? "1 charge"
                    : `${card.stripeChargeCount ?? 0} charges`}
                </Badge>
              ) : null}
              {laneBadges(card.reconciliationLanes).map((b) => (
                <Badge
                  key={b.key}
                  variant={b.variant}
                  className="text-[10px]"
                  data-testid={`card-reconciliation-lane-${b.key}-${card.stagedPaymentId}`}
                >
                  {b.label}
                </Badge>
              ))}
            </div>
            {card.rawReference || card.lineDescription ? (
              <div className="truncate text-xs text-muted-foreground">
                {card.lineDescription || card.rawReference}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {isReconciled ? (
              <Badge variant="default">Reconciled</Badge>
            ) : card.ready ? (
              <Badge variant="default">Ready</Badge>
            ) : (
              <Badge variant="secondary">Needs review</Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggle}
              data-testid={`toggle-card-${card.stagedPaymentId}`}
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* The connections this card resolves, stated explicitly. */}
        <div className="space-y-1">
          {stripeConn ? (
            <ConnectionRow
              from="Stripe"
              to="QuickBooks"
              status={stripeConn}
              testId={`conn-stripe-qb-${card.stagedPaymentId}`}
            />
          ) : null}
          <ConnectionRow
            from="QuickBooks"
            to="Gift"
            status={qbGiftConn}
            name={giftName}
            href={giftHref}
            context={donorContext}
            testId={`conn-qb-gift-${card.stagedPaymentId}`}
          />
          {pledgeConn ? (
            <ConnectionRow
              from="Gift"
              to="Pledge"
              status={pledgeConn}
              name={card.proposedOpportunityName}
              testId={`conn-gift-pledge-${card.stagedPaymentId}`}
            />
          ) : null}
        </div>

        {isReconciled && card.finalAmountSource ? (
          <div className="text-xs text-muted-foreground">
            Recorded{" "}
            {card.resolvedGiftAmount
              ? `${formatCurrency(card.resolvedGiftAmount)} `
              : ""}
            from {FINAL_AMOUNT_SOURCE_LABEL[card.finalAmountSource]}.
          </div>
        ) : null}

        {expanded ? (
          <CardResolver
            stagedPaymentId={card.stagedPaymentId}
            stagedStatus={card.status}
            reconciled={isReconciled}
            busy={busy}
            onApprove={onApprove}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function findCandidate(
  graph: ReconciliationGraph,
  nodeType: ReconciliationMatchNodeType,
): ReconciliationCandidate | null {
  const node = graph.nodes.find((n) => n.nodeType === nodeType);
  if (!node || !node.selectedId) return null;
  return node.candidates.find((c) => c.id === node.selectedId) ?? null;
}

function nodeState(graph: ReconciliationGraph, nodeType: ReconciliationMatchNodeType) {
  return graph.nodes.find((n) => n.nodeType === nodeType)?.state ?? null;
}

/** A read-only record card (Stripe charge / QuickBooks deposit). */
function RecordCard({
  title,
  amount,
  children,
}: {
  title: string;
  amount?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{title}</div>
        {amount ? (
          <span className="text-sm font-semibold tabular-nums">
            {formatCurrency(amount)}
          </span>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </div>
  );
}

function CardResolver({
  stagedPaymentId,
  stagedStatus,
  reconciled,
  busy,
  onApprove,
}: {
  stagedPaymentId: string;
  stagedStatus: string;
  reconciled: boolean;
  busy: boolean;
  onApprove: (body: ApproveCompleteMatchBody) => Promise<unknown>;
}) {
  const { data: graph, isLoading, isError } = useGetReconciliationGraph(
    stagedPaymentId,
    {
      query: {
        enabled: !reconciled,
        queryKey: getGetReconciliationGraphQueryKey(stagedPaymentId),
      },
    },
  );

  const [donor, setDonor] = useState<ReconciliationCandidate | null>(null);
  const [gift, setGift] = useState<ReconciliationCandidate | null>(null);
  const [opportunity, setOpportunity] =
    useState<ReconciliationCandidate | null>(null);
  const [outcomeChoice, setOutcomeChoice] = useState<OutcomeChoice>(
    "create_gift_from_opportunity",
  );
  const [override, setOverride] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Initialise the selections from the server's auto-locked guesses whenever a
  // fresh graph arrives for this card.
  useEffect(() => {
    if (!graph) return;
    setDonor(findCandidate(graph, "donor"));
    setGift(findCandidate(graph, "gift"));
    setOpportunity(findCandidate(graph, "opportunity"));
    setOutcomeChoice("create_gift_from_opportunity");
    setOverride("");
    setConfirmOpen(false);
  }, [graph]);

  const derived = useMemo(() => {
    if (!graph) return null;
    return deriveApproveBody({
      donor,
      gift,
      opportunity,
      outcomeChoice,
      overrideAmountMismatchReason: override,
      graph,
    });
  }, [graph, donor, gift, opportunity, outcomeChoice, override]);

  if (reconciled) return null;
  if (isLoading) {
    return (
      <p className="border-t pt-3 text-sm text-muted-foreground">Loading match…</p>
    );
  }
  if (isError || !graph) {
    return (
      <p className="border-t pt-3 text-sm text-destructive">
        Couldn't load this card's match graph.
      </p>
    );
  }

  const qb = graph.evidence.qb;
  const stripe = graph.evidence.stripe;
  const stripeConn = stripe ? stripeToQbStatus(stripe.reconciliationStatus) : null;
  const qbGiftConn = qbToGiftStatus({
    stagedStatus,
    giftState: nodeState(graph, "gift"),
  });
  const pledgeConn = giftToPledgeStatus(nodeState(graph, "opportunity"));

  const amountBlocked = hasAmountBlocker(graph.blockers);
  const showOpportunityChoice = !gift && Boolean(opportunity);
  const stripeChargeId = stripe?.chargeId ?? null;
  // The amount approving will record on the gift: Stripe GROSS wins when a single
  // charge backs the money, otherwise the QuickBooks anchor amount (mirrors the
  // server's stampGiftFinalAmount precedence).
  const evidenceAmount = stripeChargeId
    ? stripe?.grossAmount ?? null
    : qb.amount;

  return (
    <div className="space-y-3 border-t pt-4">
      {/* SECTION 1 — The money (sources). Stripe sits above QuickBooks so the QB
          deposit ends up adjacent to the gift it reconciles to, for comparison. */}
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        The money
      </div>
      {stripe ? (
        <>
          <RecordCard title="Stripe charge" amount={stripe.grossAmount}>
            <Stat label="Gross" value={formatCurrency(stripe.grossAmount)} />
            <Stat label="Fee" value={formatCurrency(stripe.feeAmount)} />
            <Stat label="Net" value={formatCurrency(stripe.netAmount)} />
            <Stat
              label="Charges"
              value={String(stripe.chargeCount ?? (stripe.chargeId ? 1 : 0))}
            />
          </RecordCard>
          <ConnectionLink
            from="Stripe"
            to="QuickBooks"
            status={stripeConn}
            testId={`link-stripe-qb-${stagedPaymentId}`}
          />
          {stripeConn?.hint ? (
            <p className="pl-6 text-xs text-muted-foreground">{stripeConn.hint}</p>
          ) : null}
        </>
      ) : null}
      <RecordCard title="QuickBooks deposit (anchor)" amount={qb.amount}>
        <Stat label="Amount" value={formatCurrency(qb.amount)} />
        <Stat label="Received" value={formatDate(qb.dateReceived)} />
        <Stat label="Payer" value={qb.payerName || "—"} />
        <Stat label="Method" value={qb.paymentMethod || "—"} />
      </RecordCard>

      {/* QuickBooks → Gift */}
      <ConnectionLink
        from="QuickBooks"
        to="Gift"
        status={qbGiftConn}
        testId={`link-qb-gift-${stagedPaymentId}`}
      />

      {graph.blockers.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <div className="font-medium">Needs attention before approving:</div>
          <ul className="ml-4 list-disc">
            {graph.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* SECTION 2 — The gift this money reconciles to (donor + gift describe the
          same gift; they connect to the QuickBooks deposit above, not Stripe). */}
      <div className="space-y-3 rounded-md border p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          The gift this money belongs to
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Donor</Label>
          <ReconciliationNodeTypeahead
            nodeType="donor"
            stagedPaymentId={stagedPaymentId}
            value={donor}
            onChange={setDonor}
            placeholder="Search donors…"
            testId={`donor-typeahead-${stagedPaymentId}`}
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">
            Existing gift (link instead of minting)
          </Label>
          <ReconciliationNodeTypeahead
            nodeType="gift"
            stagedPaymentId={stagedPaymentId}
            donorId={donor?.id ?? null}
            value={gift}
            onChange={setGift}
            placeholder="Search gifts…"
            testId={`gift-typeahead-${stagedPaymentId}`}
          />
        </div>
      </div>

      {/* Gift → Pledge (optional) */}
      <ConnectionLink
        from="Gift"
        to="Pledge"
        status={pledgeConn}
        testId={`link-gift-pledge-${stagedPaymentId}`}
      />
      <div className="space-y-3 rounded-md border p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pledge / opportunity (optional)
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">
            Opportunity / pledge
          </Label>
          <ReconciliationNodeTypeahead
            nodeType="opportunity"
            stagedPaymentId={stagedPaymentId}
            donorId={donor?.id ?? null}
            value={opportunity}
            onChange={setOpportunity}
            placeholder="Search opportunities…"
            testId={`opportunity-typeahead-${stagedPaymentId}`}
          />
        </div>
        {showOpportunityChoice ? (
          <div className="rounded-md border p-3">
            <Label className="text-xs text-muted-foreground">
              How should this opportunity be handled?
            </Label>
            <RadioGroup
              value={outcomeChoice}
              onValueChange={(v) => setOutcomeChoice(v as OutcomeChoice)}
              className="mt-2 space-y-2"
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem
                  value="create_gift_from_opportunity"
                  id={`oc-onetime-${stagedPaymentId}`}
                  className="mt-1"
                />
                <Label
                  htmlFor={`oc-onetime-${stagedPaymentId}`}
                  className="font-normal"
                >
                  One-time gift linked to the opportunity (derives to cash-in when
                  fully paid).
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem
                  value="convert_to_pledge_and_first_payment"
                  id={`oc-pledge-${stagedPaymentId}`}
                  className="mt-1"
                />
                <Label
                  htmlFor={`oc-pledge-${stagedPaymentId}`}
                  className="font-normal"
                >
                  Convert to a pledge and record this as the first payment{" "}
                  <span className="text-muted-foreground">
                    (open opportunities only)
                  </span>
                  .
                </Label>
              </div>
            </RadioGroup>
          </div>
        ) : null}
      </div>

      {amountBlocked ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <div className="text-sm font-medium text-amber-900">
            Amounts don&apos;t match — confirm the override to approve
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-amber-900">
            <span>
              Auto-matched gift:{" "}
              <span className="font-medium tabular-nums">
                {gift?.amount ? formatCurrency(gift.amount) : "—"}
              </span>
            </span>
            <span>
              Evidence ({stripeChargeId ? "Stripe gross" : "QuickBooks"}):{" "}
              <span className="font-medium tabular-nums">
                {evidenceAmount ? formatCurrency(evidenceAmount) : "—"}
              </span>
            </span>
          </div>
          <p className="text-xs text-amber-800">
            Approving records the evidence amount on the gift and rescales its
            single allocation (or flags it for review if it has several). Enter a
            reason to override the mismatch — this is required to enable Approve.
          </p>
          <Label htmlFor={`override-${stagedPaymentId}`} className="sr-only">
            Amount-mismatch override reason
          </Label>
          <Textarea
            id={`override-${stagedPaymentId}`}
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            placeholder="Why is it OK that the amounts differ? (e.g. partial payment, processor fee, corrected amount)"
            rows={2}
            className="bg-white"
            data-testid={`override-${stagedPaymentId}`}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <div className="min-w-0 space-y-0.5">
          <p
            className={`text-sm ${
              derived?.ok ? "text-muted-foreground" : "text-amber-700"
            }`}
          >
            {derived?.ok ? derived.summary : derived?.reason}
          </p>
          {derived?.ok ? (
            <p className="text-xs text-muted-foreground">
              Records{" "}
              {evidenceAmount ? formatCurrency(evidenceAmount) : "the evidence amount"}{" "}
              on the gift ({stripeChargeId ? "Stripe gross" : "QuickBooks amount"}).
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          disabled={busy || !derived?.ok}
          onClick={() => {
            if (!derived?.ok) return;
            // A donor switch (or any other gated outcome) routes through an
            // explicit confirmation before sending; everything else approves
            // directly.
            if (derived.confirm) {
              setConfirmOpen(true);
              return;
            }
            void onApprove(derived.body);
          }}
          data-testid={`approve-${stagedPaymentId}`}
        >
          {busy ? "Approving…" : "Approve"}
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid={`confirm-switch-${stagedPaymentId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {derived?.ok && derived.confirm
                ? derived.confirm.title
                : "Confirm"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {derived?.ok && derived.confirm
                ? derived.confirm.description
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (derived?.ok) void onApprove(derived.body);
              }}
              data-testid={`confirm-switch-action-${stagedPaymentId}`}
            >
              Switch &amp; approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
