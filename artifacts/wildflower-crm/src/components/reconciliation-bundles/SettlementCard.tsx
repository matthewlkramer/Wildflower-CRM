import { useState } from "react";
import { Check, Loader2, Search, X } from "lucide-react";
import {
  useConfirmSettlementLink,
  useRejectSettlementProposal,
  type BundleAnchor,
  type BundleAnchorType,
  type PayoutChargeSummary,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { extractGateIssues } from "@/lib/reconciliation";
import { ResolveTieDialog } from "./ResolveTieDialog";
import { is409, resolveConfirmArgs } from "./settlement-actions";
import { shortId } from "./bundle-ui";

const SOURCE_LABEL: Record<BundleAnchorType, string> = {
  stripe_payout: "Stripe",
  qb_staged_payment: "QuickBooks",
};

function errMessage(err: unknown): string {
  const issues = extractGateIssues(err);
  if (issues.length > 0) return issues.join(" · ");
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * Per-charge breakdown for a Stripe payout — each charge's payer name + amount so
 * a reviewer sees who the money is from without drilling in. Capped/scrollable so
 * a many-charge payout stays readable; renders nothing when there are no charges
 * (the count fallback in the card header covers that case).
 */
export function ChargeList({
  charges,
}: {
  charges: PayoutChargeSummary[] | undefined;
}) {
  if (!charges || charges.length === 0) return null;
  return (
    <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto pr-1 text-xs text-muted-foreground">
      {charges.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-2">
          <span className="truncate">{c.payerName?.trim() || "(no name)"}</span>
          <span className="shrink-0 tabular-nums">
            {c.amount != null ? formatCurrency(c.amount) : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Card-first settlement anchor (gift-report style). Shows the anchor facts, its
 * proposed counterpart inline, and inline Approve / Reject when a proposal
 * exists — or a Resolve (search-to-tie) entry point when it doesn't.
 *
 * This card is Plane 1 ONLY (docs/reconciliation-design.md §4.3/§4.4): Approve
 * confirms JUST the payout↔deposit settlement tie via the dedicated confirm
 * endpoint — it does NOT open or commit a per-charge bundle. Per-charge → gift
 * booking (Plane 2) is owned by the Gift report, so a "linked" (proposed)
 * settlement approves in one click and a charge still awaiting a donor decision
 * no longer blocks it. `onChanged` refreshes the workbench.
 */
export function SettlementCard({
  anchor: a,
  selectable,
  selected,
  onToggleSelect,
  onChanged,
}: {
  anchor: BundleAnchor;
  /** Matched-column cards are view-only: no checkbox, no action controls. */
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const confirmM = useConfirmSettlementLink();
  const rejectM = useRejectSettlementProposal();

  const [resolveOpen, setResolveOpen] = useState(false);

  const busy = confirmM.isPending || rejectM.isPending;
  const proposal = a.proposedMatch;

  const handleApprove = async () => {
    // A proposal only ever appears on the Stripe-payout anchor, so anchorId IS
    // the payout the confirm endpoint is keyed by.
    try {
      const res = await confirmM.mutateAsync({
        payoutId: a.anchorId,
        data: {},
      });
      toast({
        title:
          res.kind === "already_confirmed"
            ? "Already settled."
            : res.kind === "conflict_kept"
              ? "Settlement confirmed — kept the approved gift."
              : "Settlement approved.",
      });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        toast({
          title: "The settlement changed — refreshed.",
          description: "Review the updated card and try again.",
        });
        onChanged();
      } else {
        toast({ title: "Couldn't approve", description: errMessage(err) });
      }
    }
  };

  const handleReject = async () => {
    try {
      const res = await rejectM.mutateAsync({ payoutId: a.anchorId });
      toast({
        title: res.rejected
          ? "Proposed match rejected."
          : "No proposed match to reject.",
      });
      onChanged();
    } catch (err) {
      toast({ title: "Couldn't reject", description: errMessage(err) });
    }
  };

  const handleResolvePick = async (counterpartId: string) => {
    try {
      const { payoutId, depositStagedPaymentId } = resolveConfirmArgs(
        a,
        counterpartId,
      );
      await confirmM.mutateAsync({
        payoutId,
        data: { depositStagedPaymentId },
      });
      setResolveOpen(false);
      toast({ title: "Settlement approved." });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        toast({ title: "The settlement changed — try resolving again." });
      } else {
        toast({ title: "Couldn't resolve", description: errMessage(err) });
      }
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border text-sm transition-colors",
        selected ? "border-primary bg-primary/5" : "bg-card",
      )}
      data-testid={`card-settlement-${a.anchorId}`}
    >
      <div className="flex items-start gap-2 p-2">
        {selectable && (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelect}
            className="mt-0.5"
            data-testid={`checkbox-settlement-${a.anchorId}`}
            aria-label="Select settlement anchor"
          />
        )}
        <div className="min-w-0 flex-1">
          {/* Anchor facts */}
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <Badge variant="secondary" className="text-[10px] font-normal">
                {SOURCE_LABEL[a.anchorType]}
              </Badge>
              <span className="font-medium">{shortId(a.anchorId)}</span>
            </span>
            <span className="font-semibold">
              {a.amount != null ? formatCurrency(a.amount) : "—"}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {a.date ? formatDate(a.date) : "—"}
            {(a.charges?.length ?? 0) === 0 && a.chargeCount != null
              ? ` · ${a.chargeCount} charges`
              : ""}
            {a.payerName ? ` · ${a.payerName}` : ""}
          </div>
          <ChargeList charges={a.charges} />

          {/* Proposed counterpart inline */}
          {proposal && (
            <div className="mt-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
              <div className="flex items-center gap-1 truncate">
                <span className="text-muted-foreground">→</span>
                <span className="font-medium">
                  {SOURCE_LABEL[proposal.counterpartType]}{" "}
                  {shortId(proposal.counterpartId)}
                </span>
              </div>
              <div className="mt-0.5 text-muted-foreground">
                {proposal.amount != null ? formatCurrency(proposal.amount) : "—"}
                {proposal.date ? ` · ${formatDate(proposal.date)}` : ""}
                {proposal.chargeCount != null
                  ? ` · ${proposal.chargeCount} charges`
                  : ""}
              </div>
              {proposal.conflictGiftId && (
                <div className="mt-1 text-amber-700">
                  Conflicts with an approved QB gift — approving keeps it.
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          {selectable && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {proposal ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={busy}
                    onClick={handleApprove}
                    data-testid={`button-settlement-approve-${a.anchorId}`}
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={busy}
                    onClick={handleReject}
                    data-testid={`button-settlement-reject-${a.anchorId}`}
                  >
                    <X className="h-3 w-3" />
                    Reject
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={busy}
                  onClick={() => setResolveOpen(true)}
                  data-testid={`button-settlement-resolve-${a.anchorId}`}
                >
                  <Search className="h-3 w-3" />
                  Resolve
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {resolveOpen && (
        <ResolveTieDialog
          anchor={a}
          open={resolveOpen}
          onOpenChange={setResolveOpen}
          onPick={handleResolvePick}
          busy={busy}
        />
      )}
    </div>
  );
}
