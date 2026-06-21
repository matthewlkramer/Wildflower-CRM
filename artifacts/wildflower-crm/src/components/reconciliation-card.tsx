import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronUp } from "lucide-react";
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
  EDGE_STATE_BADGE,
  FINAL_AMOUNT_SOURCE_LABEL,
  deriveApproveBody,
  hasAmountBlocker,
  qbTrackStatus,
  stripeTrackStatus,
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

function NodeSummary({
  label,
  name,
  state,
}: {
  label: string;
  name?: string | null;
  state?: ReconciliationCardType["donorState"];
}) {
  const badge = state ? EDGE_STATE_BADGE[state] : null;
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}:</span>
      <span className="truncate font-medium">{name || "—"}</span>
      {badge ? (
        <Badge variant={badge.variant} className="px-1.5 py-0 text-[10px]">
          {badge.label}
        </Badge>
      ) : null}
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
  // Explicit per-track status: QuickBooks (always) + Stripe (when a payout backs
  // the money). This replaces the single sweeping badge with which side is
  // approved vs still awaiting approval.
  const qbTrack = qbTrackStatus(card.status);
  const stripeTrack = card.hasStripeEvidence
    ? stripeTrackStatus(card.stripeReconciliationStatus)
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span
            className="flex items-center gap-1.5"
            data-testid={`track-qb-${card.stagedPaymentId}`}
          >
            <span className="text-xs text-muted-foreground">QuickBooks</span>
            <Badge variant={qbTrack.variant} className="px-1.5 py-0 text-[10px]">
              {qbTrack.label}
            </Badge>
          </span>
          {stripeTrack ? (
            <span
              className="flex items-center gap-1.5"
              data-testid={`track-stripe-${card.stagedPaymentId}`}
            >
              <span className="text-xs text-muted-foreground">Stripe</span>
              <Badge
                variant={stripeTrack.variant}
                className="px-1.5 py-0 text-[10px]"
              >
                {stripeTrack.label}
              </Badge>
            </span>
          ) : null}
        </div>
        {isReconciled ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Gift:</span>
            {card.resolvedGiftId ? (
              <Link
                href={`/gifts/${card.resolvedGiftId}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {card.resolvedGiftName || card.resolvedGiftId}
              </Link>
            ) : (
              <span className="font-medium">{card.resolvedGiftName || "—"}</span>
            )}
            {card.resolvedGiftAmount ? (
              <span className="tabular-nums">
                {formatCurrency(card.resolvedGiftAmount)}
              </span>
            ) : null}
            {card.finalAmountSource ? (
              <Badge variant="outline" className="text-[10px]">
                {FINAL_AMOUNT_SOURCE_LABEL[card.finalAmountSource]}
              </Badge>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-1 sm:grid-cols-3">
            <NodeSummary
              label="Donor"
              name={card.proposedDonorName}
              state={card.donorState}
            />
            <NodeSummary
              label="Gift"
              name={card.proposedGiftName}
              state={card.giftState}
            />
            <NodeSummary
              label="Opportunity"
              name={card.proposedOpportunityName}
              state={card.opportunityState}
            />
          </div>
        )}

        {expanded ? (
          <CardResolver
            stagedPaymentId={card.stagedPaymentId}
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

function CardResolver({
  stagedPaymentId,
  reconciled,
  busy,
  onApprove,
}: {
  stagedPaymentId: string;
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

  const stripe = graph.evidence.stripe;
  const amountBlocked = hasAmountBlocker(graph.blockers);
  const showOpportunityChoice = !gift && Boolean(opportunity);
  const stripeChargeId = stripe?.chargeId ?? null;
  // The amount approving will record on the gift: Stripe GROSS wins when a single
  // charge backs the money, otherwise the QuickBooks anchor amount (mirrors the
  // server's stampGiftFinalAmount precedence).
  const evidenceAmount = stripeChargeId
    ? stripe?.grossAmount ?? null
    : graph.evidence.qb.amount;

  return (
    <div className="space-y-4 border-t pt-4">
      {/* QB anchor + Stripe evidence (read-only). */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-xs font-medium text-muted-foreground">
          QuickBooks anchor
        </div>
        <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Amount" value={formatCurrency(graph.evidence.qb.amount)} />
          <Stat
            label="Received"
            value={formatDate(graph.evidence.qb.dateReceived)}
          />
          <Stat label="Payer" value={graph.evidence.qb.payerName || "—"} />
          <Stat label="Method" value={graph.evidence.qb.paymentMethod || "—"} />
        </div>
        {stripe ? (
          <div className="mt-3 border-t pt-3">
            <div className="text-xs font-medium text-muted-foreground">
              Stripe evidence (gross takes precedence)
            </div>
            <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Gross" value={formatCurrency(stripe.grossAmount)} />
              <Stat label="Fee" value={formatCurrency(stripe.feeAmount)} />
              <Stat label="Net" value={formatCurrency(stripe.netAmount)} />
              <Stat
                label="Charges"
                value={String(stripe.chargeCount ?? (stripe.chargeId ? 1 : 0))}
              />
            </div>
            {stripe.reconciliationStatus ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Stripe payout:{" "}
                <span className="font-medium text-foreground">
                  {stripeTrackStatus(stripe.reconciliationStatus)?.label ??
                    stripe.reconciliationStatus}
                </span>
                {stripe.reconciliationStatus === "conflict_approved" ? (
                  <>
                    {" "}
                    — QuickBooks is already approved into a gift; confirm to tie
                    this Stripe payout in (not a money discrepancy).
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

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

      {/* The 3 resolvable nodes. */}
      <div className="space-y-3">
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
        <div>
          <Label className="text-xs text-muted-foreground">
            Opportunity / pledge (optional)
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className={`text-sm ${
            derived?.ok ? "text-muted-foreground" : "text-amber-700"
          }`}
        >
          {derived?.ok ? derived.summary : derived?.reason}
        </p>
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
