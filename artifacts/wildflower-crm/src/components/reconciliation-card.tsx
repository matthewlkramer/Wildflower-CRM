import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  Circle,
  MinusCircle,
  Users,
  Unlink,
  MessageSquarePlus,
  type LucideIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetReconciliationGraph,
  getGetReconciliationGraphQueryKey,
  useSetStagedPaymentFundingSource,
  useUngroupStagedPayments,
  useCreateReconciliationProposal,
  useListReconciliationCardProposals,
  getListReconciliationCardProposalsQueryKey,
  type ReconciliationCard as ReconciliationCardType,
  type ReconciliationCandidate,
  type ReconciliationGraph,
  type ReconciliationMatchNodeType,
  type ReconciliationLaneStatus,
  type ApproveCompleteMatchBody,
  type StagedPaymentFundingSource,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/format";
import { ReconciliationNodeTypeahead } from "@/components/reconciliation-node-typeahead";
import {
  FINAL_AMOUNT_SOURCE_LABEL,
  FUNDING_SOURCE_LABEL,
  FUNDING_SOURCE_OPTIONS,
  deriveApproveBody,
  giftToPledgeStatus,
  hasAmountBlocker,
  qbToGiftStatus,
  stripeToQbStatus,
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

/** Icon + soft color for each funding/CRM lane status. */
const LANE_CHIP: Record<
  ReconciliationLaneStatus,
  { label: string; Icon: LucideIcon; className: string }
> = {
  confirmed: {
    label: "Confirmed",
    Icon: CheckCircle2,
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  proposed: {
    label: "Proposed",
    Icon: AlertCircle,
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  unlinked: {
    label: "Not linked",
    Icon: Circle,
    className: "border-slate-200 bg-slate-50 text-slate-600",
  },
  exempt: {
    label: "Exempt",
    Icon: MinusCircle,
    className: "border-slate-200 bg-slate-50 text-slate-500",
  },
};

function LaneStatusChip({
  status,
  testId,
}: {
  status: ReconciliationLaneStatus;
  testId?: string;
}) {
  const cfg = LANE_CHIP[status];
  const Icon = cfg.Icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        cfg.className,
      )}
      data-testid={testId}
    >
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

/**
 * One labelled "Status Row": a lane name (Funding / CRM record), its lane status
 * chip, a one-line human summary, and an optional trailing control.
 */
function LaneRow({
  label,
  status,
  summary,
  trailing,
  testId,
}: {
  label: string;
  status: ReconciliationLaneStatus;
  summary: ReactNode;
  trailing?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid={testId}
    >
      <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <LaneStatusChip status={status} />
      <span className="min-w-0 flex-1 truncate text-sm">{summary}</span>
      {trailing}
    </div>
  );
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Please try again.";
}

/**
 * Manual funding-source override. Setting it pins funding_source_provenance to
 * 'manual', so the server's auto-inference never overwrites it on the next pull.
 */
function FundingSourceEditor({
  card,
  onChanged,
}: {
  card: ReconciliationCardType;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const setFunding = useSetStagedPaymentFundingSource({
    mutation: {
      onSuccess: () => {
        setOpen(false);
        onChanged?.();
      },
      onError: (e) =>
        toast({
          variant: "destructive",
          title: "Couldn't set funding source",
          description: errMessage(e),
        }),
    },
  });
  const current = card.fundingSource ?? null;
  const isManual = card.fundingSourceProvenance === "manual";

  function choose(value: StagedPaymentFundingSource | null) {
    setFunding.mutate({
      id: card.stagedPaymentId,
      data: { fundingSource: value },
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          data-testid={`funding-source-${card.stagedPaymentId}`}
        >
          {current ? FUNDING_SOURCE_LABEL[current] : "Set source"}
          {isManual ? (
            <Badge variant="outline" className="px-1 py-0 text-[9px]">
              manual
            </Badge>
          ) : null}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          Funding source (origin)
        </div>
        <div className="max-h-64 overflow-auto">
          {FUNDING_SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={setFunding.isPending}
              onClick={() => choose(opt)}
              className={cn(
                "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted",
                opt === current && "font-medium",
              )}
              data-testid={`funding-source-opt-${opt}-${card.stagedPaymentId}`}
            >
              {FUNDING_SOURCE_LABEL[opt]}
              {opt === current ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              ) : null}
            </button>
          ))}
        </div>
        {current ? (
          <>
            <div className="my-1 border-t" />
            <button
              type="button"
              disabled={setFunding.isPending}
              onClick={() => choose(null)}
              className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
            >
              Clear source
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A "same physical gift" source group: the members a human grouped, the group
 * total, and an Ungroup action. The card's stagedPaymentId is the group
 * representative; approving the card reconciles the whole group.
 */
function GroupPanel({
  card,
  onChanged,
}: {
  card: ReconciliationCardType;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const members = card.sourceGroupMembers ?? [];
  const ungroup = useUngroupStagedPayments({
    mutation: {
      onSuccess: () => {
        toast({ title: "Group dissolved." });
        onChanged?.();
      },
      onError: (e) =>
        toast({
          variant: "destructive",
          title: "Couldn't ungroup",
          description: errMessage(e),
        }),
    },
  });

  return (
    <div
      className="space-y-2 rounded-md border bg-muted/30 p-3"
      data-testid={`group-panel-${card.stagedPaymentId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          {card.sourceGroupCount ?? members.length} payments grouped as one
          physical gift
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          disabled={ungroup.isPending}
          onClick={() =>
            ungroup.mutate({
              data: { stagedPaymentIds: members.map((m) => m.stagedPaymentId) },
            })
          }
          data-testid={`ungroup-${card.stagedPaymentId}`}
        >
          <Unlink className="h-3 w-3" />
          Ungroup
        </Button>
      </div>
      <div className="divide-y">
        {members.map((m) => (
          <div
            key={m.stagedPaymentId}
            className="flex items-center justify-between gap-2 py-1 text-xs"
          >
            <div className="min-w-0 truncate">
              <span className="font-medium">{m.payerName || "—"}</span>
              {m.qbDocNumber ? (
                <span className="text-muted-foreground"> · #{m.qbDocNumber}</span>
              ) : null}
              {m.fundingSource ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {FUNDING_SOURCE_LABEL[m.fundingSource]}
                </span>
              ) : null}
              {m.isRepresentative ? (
                <Badge variant="outline" className="ml-1 px-1 py-0 text-[9px]">
                  primary
                </Badge>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3 tabular-nums">
              <span className="text-muted-foreground">
                {m.dateReceived ? formatDate(m.dateReceived) : "—"}
              </span>
              <span>{m.amount ? formatCurrency(m.amount) : "—"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReconciliationCard({
  card,
  expanded,
  onToggle,
  busy,
  onApprove,
  onChanged,
  selectable,
  selected,
  onSelectToggle,
}: {
  card: ReconciliationCardType;
  expanded: boolean;
  onToggle: () => void;
  busy: boolean;
  onApprove: (body: ApproveCompleteMatchBody) => Promise<unknown>;
  /** Invalidate the cards list after a funding-source/group mutation. */
  onChanged?: () => void;
  /** Show the multi-select grouping checkbox. */
  selectable?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
}) {
  const isReconciled = card.status === "reconciled";
  const lanes = card.reconciliationLanes ?? {
    funding: "unlinked" as ReconciliationLaneStatus,
    crmRecord: null,
  };

  // A source group reconciles for the SUM of its members.
  const headerAmount =
    card.isSourceGroup && card.sourceGroupTotalAmount != null
      ? card.sourceGroupTotalAmount
      : card.amount;

  // Funding lane summary — what the money is / where it came from.
  const fundingSummary = card.hasStripeEvidence
    ? `Stripe · ${
        card.stripeChargeCount === 1
          ? "1 charge"
          : `${card.stripeChargeCount ?? 0} charges`
      }`
    : card.fundingSource
      ? `${FUNDING_SOURCE_LABEL[card.fundingSource]} · QuickBooks deposit`
      : "QuickBooks deposit";

  // CRM-record lane summary — the gift/donor this money books to.
  const crmText = isReconciled
    ? card.resolvedGiftName || card.resolvedGiftId || "Reconciled gift"
    : card.proposedGiftName
      ? `${card.proposedGiftName}${
          card.proposedDonorName ? ` · ${card.proposedDonorName}` : ""
        }`
      : card.proposedDonorName
        ? `Donor: ${card.proposedDonorName}`
        : "No gift linked yet";
  const crmSummary =
    isReconciled && card.resolvedGiftId ? (
      <Link
        href={`/gifts/${card.resolvedGiftId}`}
        className="truncate font-medium underline-offset-2 hover:underline"
      >
        {crmText}
      </Link>
    ) : (
      crmText
    );

  return (
    <Card data-testid={`reconciliation-card-${card.stagedPaymentId}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            {selectable ? (
              <Checkbox
                checked={selected ?? false}
                onCheckedChange={() => onSelectToggle?.()}
                className="mt-1"
                aria-label="Select for grouping"
                data-testid={`select-card-${card.stagedPaymentId}`}
              />
            ) : null}
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold tabular-nums">
                  {formatCurrency(headerAmount)}
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
                {card.isSourceGroup ? (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <Users className="h-3 w-3" />
                    {card.sourceGroupCount ??
                      card.sourceGroupMembers?.length ??
                      0}{" "}
                    grouped
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
        {card.isSourceGroup ? (
          <GroupPanel card={card} onChanged={onChanged} />
        ) : null}

        {/* Status Rows — the two reconciliation lanes (funding + CRM record),
            each a labelled status row with a human summary. */}
        <div
          className="space-y-2"
          data-testid={`status-rows-${card.stagedPaymentId}`}
        >
          <LaneRow
            label="Funding"
            status={lanes.funding}
            summary={fundingSummary}
            trailing={
              card.isSourceGroup ? undefined : (
                <FundingSourceEditor card={card} onChanged={onChanged} />
              )
            }
            testId={`lane-funding-${card.stagedPaymentId}`}
          />
          {lanes.crmRecord != null ? (
            <LaneRow
              label="CRM record"
              status={lanes.crmRecord}
              summary={crmSummary}
              testId={`lane-crm-${card.stagedPaymentId}`}
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

/**
 * "Propose alternative" — leave a free-text comment on this card instead of
 * approving it. Append-only notes (with author + timestamp) that are read back
 * later to improve this row's match and the matcher overall. Never mutates any
 * match/donor/gift state.
 */
function ProposeAlternative({
  stagedPaymentId,
  disabled,
}: {
  stagedPaymentId: string;
  disabled: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");

  const listQueryKey = getListReconciliationCardProposalsQueryKey(stagedPaymentId);
  const { data: list } = useListReconciliationCardProposals(stagedPaymentId, {
    query: { enabled: open, queryKey: listQueryKey },
  });
  const proposals = list?.data ?? [];

  const create = useCreateReconciliationProposal({
    mutation: {
      onSuccess: () => {
        setComment("");
        void queryClient.invalidateQueries({ queryKey: listQueryKey });
        toast({ title: "Comment saved" });
      },
      onError: () => {
        toast({
          title: "Couldn't save comment",
          description: "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const trimmed = comment.trim();

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-testid={`propose-alternative-${stagedPaymentId}`}
      >
        <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
        Propose alternative
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid={`propose-alternative-dialog-${stagedPaymentId}`}>
          <DialogHeader>
            <DialogTitle>Propose an alternative</DialogTitle>
            <DialogDescription>
              Leave a note about how this row — or the matcher overall — should be
              handled. These are read back later to improve the matches; this does
              not change the match or approve anything.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor={`proposal-comment-${stagedPaymentId}`} className="sr-only">
              Comment
            </Label>
            <Textarea
              id={`proposal-comment-${stagedPaymentId}`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="e.g. The donor should be the advisor, not the DAF sponsor; or this payout belongs to a different deposit."
              rows={4}
              maxLength={10000}
              data-testid={`proposal-comment-${stagedPaymentId}`}
            />
          </div>

          {proposals.length > 0 ? (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground">
                Previous comments ({proposals.length})
              </p>
              <ul className="max-h-48 space-y-2 overflow-y-auto">
                {proposals.map((p) => (
                  <li key={p.id} className="rounded-md bg-muted/50 p-2">
                    <p className="whitespace-pre-wrap text-sm">{p.comment}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {p.createdByUserName ?? "Unknown"} ·{" "}
                      {formatDate(p.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              Close
            </Button>
            <Button
              disabled={trimmed.length === 0 || create.isPending}
              onClick={() => {
                if (trimmed.length === 0) return;
                create.mutate({
                  stagedPaymentId,
                  data: { comment: trimmed },
                });
              }}
              data-testid={`proposal-submit-${stagedPaymentId}`}
            >
              {create.isPending ? "Saving…" : "Save comment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
        <div className="flex flex-wrap items-center gap-2">
          <ProposeAlternative stagedPaymentId={stagedPaymentId} disabled={busy} />
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
