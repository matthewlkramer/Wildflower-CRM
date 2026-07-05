import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  Search,
  X,
} from "lucide-react";
import {
  useAssembleReconciliationBundle,
  useConfirmReconciliationBundle,
  useDeriveReconciliationBundle,
  useRejectSettlementProposal,
  type BundleAnchor,
  type BundleAnchorType,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { extractGateIssues } from "@/lib/reconciliation";
import { BundleDraftPanel } from "./BundleDraftPanel";
import { ResolveTieDialog } from "./ResolveTieDialog";
import { approveAnchor, is409, resolveAndApprove } from "./settlement-actions";
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
 * Card-first settlement anchor (gift-report style). Shows the anchor facts, its
 * proposed counterpart inline, and inline Approve / Reject when a proposal
 * exists — or a Resolve (search-to-tie) entry point when it doesn't. The card
 * expands to fold in the full per-charge bundle editor (BundleDraftPanel),
 * replacing the old below-columns bundle box. Every mutation flows through the
 * same atomic confirm the panel used; `onChanged` refreshes the workbench.
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
  const assembleM = useAssembleReconciliationBundle();
  const deriveM = useDeriveReconciliationBundle();
  const confirmM = useConfirmReconciliationBundle();
  const rejectM = useRejectSettlementProposal();

  const [expanded, setExpanded] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  // When a QB deposit is resolved to a payout that needs review, the expanded
  // editor must anchor on THAT payout (the canonical bundle anchor).
  const [panelPayoutId, setPanelPayoutId] = useState<string | null>(null);

  const fns = {
    assemble: assembleM.mutateAsync,
    derive: deriveM.mutateAsync,
    confirm: confirmM.mutateAsync,
  };
  const busy =
    assembleM.isPending ||
    deriveM.isPending ||
    confirmM.isPending ||
    rejectM.isPending;

  const proposal = a.proposedMatch;
  const readiness = a.readiness;

  const handleApprove = async () => {
    try {
      const outcome = await approveAnchor(a, fns);
      if (outcome === "approved") {
        toast({ title: "Settlement approved." });
        onChanged();
      } else {
        setExpanded(true);
        toast({
          title: "Needs review before approving",
          description: "Resolve the flagged rows on the card, then confirm.",
        });
      }
    } catch (err) {
      if (is409(err)) {
        setExpanded(true);
        toast({
          title: "The bundle changed — opened for review.",
          description: "Review the rows and confirm again.",
        });
      } else {
        toast({ title: "Couldn't approve", description: errMessage(err) });
      }
    }
  };

  const handleReject = async () => {
    // The proposed settlement link is always keyed by the payout; a proposal
    // only ever appears on the Stripe-payout anchor, so anchorId IS the payout.
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
      const { outcome, payoutId } = await resolveAndApprove(a, counterpartId, fns);
      setResolveOpen(false);
      if (outcome === "approved") {
        toast({ title: "Settlement approved." });
        onChanged();
      } else {
        setPanelPayoutId(payoutId);
        setExpanded(true);
        toast({
          title: "Counterpart tied — review and confirm.",
          description: "Adjust the flagged rows, then confirm.",
        });
      }
    } catch (err) {
      if (is409(err)) {
        toast({ title: "The bundle changed — try resolving again." });
      } else {
        toast({ title: "Couldn't resolve", description: errMessage(err) });
      }
    }
  };

  const readinessBadge = () => {
    if (!readiness) return null;
    if (readiness.blockerCount > 0) {
      return (
        <Badge variant="outline" className="border-destructive/30 text-destructive">
          {readiness.blockerCount} blocker{readiness.blockerCount === 1 ? "" : "s"}
        </Badge>
      );
    }
    if (readiness.warningCount > 0) {
      return (
        <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
          {readiness.warningCount} warning{readiness.warningCount === 1 ? "" : "s"}
        </Badge>
      );
    }
    if (readiness.ready) {
      return (
        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
          Ready
        </Badge>
      );
    }
    return null;
  };

  const panelType: BundleAnchorType = panelPayoutId
    ? "stripe_payout"
    : a.anchorType;
  const panelId = panelPayoutId ?? a.anchorId;

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
            {a.chargeCount != null ? ` · ${a.chargeCount} charges` : ""}
            {a.payerName ? ` · ${a.payerName}` : ""}
          </div>

          {/* Proposed counterpart inline */}
          {proposal && (
            <div className="mt-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 truncate">
                  <span className="text-muted-foreground">→</span>
                  <span className="font-medium">
                    {SOURCE_LABEL[proposal.counterpartType]}{" "}
                    {shortId(proposal.counterpartId)}
                  </span>
                </span>
                {readinessBadge()}
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setExpanded((v) => !v)}
                data-testid={`button-settlement-expand-${a.anchorId}`}
              >
                {expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {expanded ? "Hide charges" : "Review charges"}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Expanded per-charge editor (folds in the retired bundle box) */}
      {selectable && expanded && (
        <div className="border-t p-3">
          <BundleDraftPanel
            key={`${panelType}:${panelId}`}
            anchorType={panelType}
            anchorId={panelId}
            onConfirmed={() => {
              setExpanded(false);
              setPanelPayoutId(null);
              onChanged();
            }}
          />
        </div>
      )}

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
