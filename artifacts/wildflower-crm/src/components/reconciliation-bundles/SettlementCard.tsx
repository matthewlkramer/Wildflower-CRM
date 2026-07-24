import { useState } from "react";
import { Link2, Loader2, Search, X } from "lucide-react";
import {
  useConfirmPayoutChargeTies,
  useConfirmSettlementLink,
  useRejectChargeQbTie,
  useRevertChargeQbTie,
  type BundleAnchor,
  type BundleAnchorType,
  type PayoutChargeSummary,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { decodeHtmlEntities, formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { extractGateIssues } from "@/lib/reconciliation";
import { ResolveTieDialog } from "./ResolveTieDialog";
import { TieChargeQbDialog } from "./TieChargeQbDialog";
import {
  apiErrorMessage,
  is409,
  isPermanentSettlementError,
} from "./settlement-actions";
import { chargeExcludedLabel, shortId } from "./bundle-ui";

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
 * Per-charge breakdown for a Stripe payout — each charge's payer name and gross,
 * with the processor fee / net and the charge description / statement descriptor
 * so a reviewer sees who the money is from and how much Stripe took without
 * drilling in. Capped/scrollable so a many-charge payout stays readable; renders
 * nothing when there are no charges (the count fallback in the card header
 * covers that case).
 */
export function ChargeList({
  charges,
  onRejectProposedQb,
  rejectingChargeId,
  onTieCharge,
  onUntieConfirmedQb,
  untieingChargeId,
}: {
  charges: PayoutChargeSummary[] | undefined;
  /** Per-row reject of a charge's PROPOSED QB tie (omit to render read-only —
   * e.g. a Matched-column card). */
  onRejectProposedQb?: (chargeId: string) => void;
  /** Charge whose reject is in flight (disables + spins just that row). */
  rejectingChargeId?: string | null;
  /** Per-row manual tie for a charge with NO confirmed or proposed QB tie —
   * opens the search-to-tie dialog (omit to render read-only). */
  onTieCharge?: (charge: PayoutChargeSummary) => void;
  /** Per-row untie of a charge's CONFIRMED QB tie — the undo for a wrong
   * confirm. Deliberately available on Matched-column cards too (a fully-tied
   * payout lives there, and that's exactly where a wrong tie is spotted).
   * Two-click: the first click arms the row, the second unties. */
  onUntieConfirmedQb?: (chargeId: string) => void;
  /** Charge whose untie is in flight (disables + spins just that row). */
  untieingChargeId?: string | null;
}) {
  // Two-click arm for untie: a single stray click is how a wrong tie happens,
  // so undoing a CONFIRMED tie asks for a deliberate second click.
  const [armedUntieId, setArmedUntieId] = useState<string | null>(null);
  if (!charges || charges.length === 0) return null;
  return (
    <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto pr-1 text-xs text-muted-foreground">
      {charges.map((c) => {
        const subtitle = decodeHtmlEntities(
          c.description ?? c.statementDescriptor ?? "",
        ).trim();
        const excludedLabel = chargeExcludedLabel(c);
        return (
          <li
            key={c.id}
            className={cn(
              "border-b border-border/40 pb-1 last:border-0",
              excludedLabel && "opacity-50",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={cn("truncate", excludedLabel && "line-through")}>
                {c.payerName?.trim() || "(no name)"}
              </span>
              <span className="shrink-0 tabular-nums">
                {c.amount != null ? formatCurrency(c.amount) : "—"}
              </span>
            </div>
            {excludedLabel && (
              <div
                className="text-[10px] font-medium text-muted-foreground"
                data-testid={`charge-excluded-${c.id}`}
              >
                {excludedLabel}
              </div>
            )}
            {subtitle && (
              <div className="truncate text-[10px] text-muted-foreground/70">
                {subtitle}
              </div>
            )}
            {(c.fee != null || c.net != null) && (
              <div className="text-[10px] tabular-nums text-muted-foreground/70">
                {c.fee != null ? `fee ${formatCurrency(c.fee)}` : ""}
                {c.fee != null && c.net != null ? " · " : ""}
                {c.net != null ? `net ${formatCurrency(c.net)}` : ""}
              </div>
            )}
            {/* Charge-grain QB settlement tie: confirmed link, or the proposed
                QB row a human still needs to approve. */}
            {c.linkedQbStagedPaymentId ? (
              <div
                className="flex items-center gap-1 text-[10px] text-emerald-700"
                data-testid={`charge-qb-tied-${c.id}`}
              >
                <Link2 className="h-2.5 w-2.5 shrink-0" />
                QB tied
                {c.linkedFeeQbStagedPaymentId ? (
                  // The sibling negative "Stripe fee" QB row of the same
                  // deposit was auto-claimed at confirm — that row is
                  // explained by this charge, not unreconciled money.
                  <span
                    className="text-muted-foreground"
                    title="The matching negative QuickBooks 'Stripe fee' row in the same deposit was linked to this charge"
                  >
                    · fee row linked
                  </span>
                ) : null}
                {onUntieConfirmedQb && (
                  // Undo for a wrong confirm — two-click so a stray click
                  // can't silently undo settlement evidence.
                  <button
                    type="button"
                    className={cn(
                      "ml-auto inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px]",
                      armedUntieId === c.id
                        ? "bg-destructive/10 font-medium text-destructive"
                        : "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
                      "disabled:opacity-50",
                    )}
                    disabled={untieingChargeId != null}
                    onClick={() => {
                      if (armedUntieId === c.id) {
                        setArmedUntieId(null);
                        onUntieConfirmedQb(c.id);
                      } else {
                        setArmedUntieId(c.id);
                      }
                    }}
                    onBlur={() =>
                      setArmedUntieId((prev) => (prev === c.id ? null : prev))
                    }
                    title={
                      armedUntieId === c.id
                        ? "Click again to remove this confirmed QuickBooks tie — the QB row returns to review and the charge can be re-tied"
                        : "Untie this charge from its QuickBooks row (undo a wrong tie)"
                    }
                    data-testid={`button-untie-charge-qb-${c.id}`}
                  >
                    {untieingChargeId === c.id ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <X className="h-2.5 w-2.5" />
                    )}
                    {armedUntieId === c.id ? "Untie? Click again" : "Untie"}
                  </button>
                )}
              </div>
            ) : c.proposedQb ? (
              <div
                className="text-[10px] text-sky-700"
                data-testid={`charge-proposed-qb-${c.id}`}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="min-w-0">
                    <span className="inline-flex items-center gap-1">
                      <Link2 className="h-2.5 w-2.5 shrink-0" />
                      Proposed QB:
                    </span>{" "}
                    {c.proposedQb.payerName?.trim() || "(no name)"}
                    {c.proposedQb.amount != null
                      ? ` · ${formatCurrency(c.proposedQb.amount)}`
                      : ""}
                    {c.proposedQb.date
                      ? ` · ${formatDate(c.proposedQb.date)}`
                      : ""}
                  </span>
                  {onRejectProposedQb && (
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      disabled={rejectingChargeId != null}
                      onClick={() => onRejectProposedQb(c.id)}
                      title="Reject this suggested QuickBooks match — it won't be suggested for this charge again"
                      data-testid={`button-reject-charge-tie-${c.id}`}
                    >
                      {rejectingChargeId === c.id ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        <X className="h-2.5 w-2.5" />
                      )}
                      Reject
                    </button>
                  )}
                </div>
                {c.proposedQb.memo?.trim() ? (
                  <span className="block truncate text-muted-foreground/70">
                    {decodeHtmlEntities(c.proposedQb.memo).trim()}
                  </span>
                ) : null}
              </div>
            ) : !excludedLabel && onTieCharge ? (
              // No confirmed tie, no proposal, still live money: the human's
              // manual entry point — find the QB row recording this charge.
              <button
                type="button"
                className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onTieCharge(c)}
                title="Search QuickBooks rows and tie the one recording this same donation"
                data-testid={`button-tie-charge-${c.id}`}
              >
                <Search className="h-2.5 w-2.5" />
                Find QuickBooks match
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Card-first settlement anchor (gift-report style). Shows the anchor facts,
 * with a Resolve (search-to-tie) entry point for an unpaired payout and
 * approve controls for proposed charge-grain QB ties.
 *
 * This card is Plane 1 ONLY (docs/reconciliation-design.md §4.3/§4.4):
 * Resolve records JUST the payout↔deposit pairing fact via the dedicated
 * endpoint — it does NOT open or commit a per-charge bundle. Per-charge →
 * gift booking (Plane 2) is owned by the Gift report. `onChanged` refreshes
 * the workbench.
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
  const chargeTiesM = useConfirmPayoutChargeTies();
  const rejectTieM = useRejectChargeQbTie();
  const revertTieM = useRevertChargeQbTie();

  const [resolveOpen, setResolveOpen] = useState(false);
  const [rejectingChargeId, setRejectingChargeId] = useState<string | null>(
    null,
  );
  const [untieingChargeId, setUntieingChargeId] = useState<string | null>(
    null,
  );
  // Charge whose manual "Find QuickBooks match" dialog is open (null = closed).
  const [tieCharge, setTieCharge] = useState<PayoutChargeSummary | null>(null);

  const busy =
    confirmM.isPending ||
    chargeTiesM.isPending ||
    rejectTieM.isPending ||
    revertTieM.isPending;
  // Charge-grain QB ties (individually-booked payouts): pending proposals a
  // human can approve in one click, and already-confirmed ties for context.
  const tiesProposed = a.chargeTiesProposed ?? 0;
  const tiesConfirmed = a.chargeTiesConfirmed ?? 0;
  // The bank payout amount is what actually hit the bank — the figure that
  // matches the QB deposit. Show it prominently; when it differs from the
  // charge-sum net (failed-payment reversals, refunds inside the payout), show
  // both so the reviewer sees why. Numeric compare tolerates "96.8"/"96.80".
  const headerAmount = a.bankAmount ?? a.amount ?? null;
  const bankDiffers =
    a.bankAmount != null &&
    a.amount != null &&
    Number(a.bankAmount) !== Number(a.amount);
  const showApproveTies = tiesProposed > 0;

  const handleApproveTies = async () => {
    // Confirms every still-valid proposed charge→QB tie on this payout in one
    // transaction; empty body = "approve the proposals".
    try {
      const res = await chargeTiesM.mutateAsync({
        payoutId: a.anchorId,
        data: {},
      });
      toast({
        title: res.payoutFullyTied
          ? `Approved ${res.tied} QB tie${res.tied === 1 ? "" : "s"} — payout fully settled.`
          : `Approved ${res.tied} QB tie${res.tied === 1 ? "" : "s"}.`,
        description:
          res.feeRowsTied > 0
            ? `Also linked ${res.feeRowsTied} matching QuickBooks Stripe-fee row${res.feeRowsTied === 1 ? "" : "s"}.`
            : undefined,
      });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        toast({
          title: "The proposed ties changed — refreshed.",
          description: errMessage(err),
        });
        onChanged();
      } else {
        toast({ title: "Couldn't approve ties", description: errMessage(err) });
      }
    }
  };

  const handleRejectChargeTie = async (chargeId: string) => {
    // Per-row reject of ONE proposed charge↔QB tie. The dismissal is
    // remembered server-side, so the proposal pass never suggests the same
    // pair again (the QB row stays available for other charges).
    setRejectingChargeId(chargeId);
    try {
      await rejectTieM.mutateAsync({ chargeId });
      toast({
        title: "Suggested QuickBooks match rejected.",
        description: "It won't be suggested for this charge again.",
      });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        toast({
          title: "The suggestion changed — refreshed.",
          description: "Review the updated card and try again.",
        });
        onChanged();
      } else {
        toast({ title: "Couldn't reject", description: errMessage(err) });
      }
    } finally {
      setRejectingChargeId(null);
    }
  };

  const handleUntieChargeTie = async (chargeId: string) => {
    // Undo of ONE CONFIRMED charge↔QB tie (a wrong "Tie selected" / approve).
    // Plane 1 only: the QB row returns to review, the charge reopens for a
    // new tie, and no gift or settlement link is touched.
    setUntieingChargeId(chargeId);
    try {
      const res = await revertTieM.mutateAsync({ chargeId });
      toast({
        title: "QuickBooks tie removed.",
        description: res.feeQbStagedPaymentId
          ? "The QuickBooks row is back in review and its Stripe-fee row was released — the charge can be re-tied."
          : "The QuickBooks row is back in review — the charge can be re-tied.",
      });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        toast({
          title: "The tie changed — refreshed.",
          description: apiErrorMessage(err) ?? errMessage(err),
        });
        onChanged();
      } else {
        toast({
          title: "Couldn't untie",
          description: errMessage(err),
          variant: "destructive",
        });
      }
    } finally {
      setUntieingChargeId(null);
    }
  };

  const handleTieChargePick = async (
    qbStagedPaymentId: string,
    opts?: { overrideExclusion?: boolean; overrideAmountMismatch?: boolean },
  ) => {
    // Manual charge-grain tie, PINNED to the dialog's charge: the picked QB
    // row is asserted to be THIS charge's money (the dialog is per-charge, so
    // naming the charge beats the amount-based placement). All-or-nothing.
    // A deliberate exclusion override re-includes the row in the same tx; a
    // deliberate amount override ties despite a gross/net mismatch (e.g. the
    // bookkeeper booked a partial or adjusted amount).
    if (!tieCharge) return;
    try {
      const res = await chargeTiesM.mutateAsync({
        payoutId: a.anchorId,
        data: {
          qbStagedPaymentIds: [qbStagedPaymentId],
          chargeId: tieCharge.id,
          ...(opts?.overrideExclusion ? { overrideExclusion: true } : {}),
          ...(opts?.overrideAmountMismatch
            ? { overrideAmountMismatch: true }
            : {}),
        },
      });
      setTieCharge(null);
      toast({
        title: res.payoutFullyTied
          ? "QuickBooks tie recorded — payout fully settled."
          : "QuickBooks tie recorded.",
        description:
          res.feeRowsTied > 0
            ? `Also linked ${res.feeRowsTied} matching QuickBooks Stripe-fee row${res.feeRowsTied === 1 ? "" : "s"}.`
            : undefined,
      });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        toast({
          title: "Couldn't tie that QuickBooks row",
          description: errMessage(err),
          variant: "destructive",
        });
        onChanged();
      } else {
        toast({
          title: "Couldn't tie",
          description: errMessage(err),
          variant: "destructive",
        });
      }
    }
  };

  const handleResolvePick = async (
    counterpartId: string,
    opts?: { overrideExclusion?: boolean },
  ) => {
    // The anchor is always the Stripe payout on this page, and the confirm
    // endpoint is keyed by the payout — the pick is the QB deposit. A
    // deliberate exclusion override re-includes the deposit in the same tx.
    try {
      await confirmM.mutateAsync({
        payoutId: a.anchorId,
        data: {
          depositStagedPaymentId: counterpartId,
          ...(opts?.overrideExclusion ? { overrideExclusion: true } : {}),
        },
      });
      setResolveOpen(false);
      toast({ title: "Settlement approved." });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        if (isPermanentSettlementError(err)) {
          toast({
            title: "Couldn't resolve this settlement",
            description: apiErrorMessage(err) ?? errMessage(err),
            variant: "destructive",
          });
        } else {
          toast({
            title: "The settlement changed — try resolving again.",
            description: apiErrorMessage(err) ?? undefined,
          });
        }
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
            {/* Prominent figure = what actually hit the bank (matches the QB
                deposit); falls back to the charge-sum net / QB amount. */}
            <span className="font-semibold">
              {headerAmount != null ? formatCurrency(headerAmount) : "—"}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {a.date ? formatDate(a.date) : "—"}
            {(a.charges?.length ?? 0) === 0 && a.chargeCount != null
              ? ` · ${a.chargeCount} charges`
              : ""}
            {a.payerName ? ` · ${a.payerName}` : ""}
          </div>
          {(a.grossTotal != null || a.feeTotal != null || bankDiffers) && (
            <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground/70">
              {a.grossTotal != null ? `gross ${formatCurrency(a.grossTotal)}` : ""}
              {a.grossTotal != null && a.feeTotal != null ? " · " : ""}
              {a.feeTotal != null ? `fee ${formatCurrency(a.feeTotal)}` : ""}
              {(a.grossTotal != null || a.feeTotal != null) && a.amount != null
                ? ` · net ${formatCurrency(a.amount)}`
                : ""}
              {/* Failed-payment reversals / refunds inside the payout make the
                  bank deposit differ from the charge-sum net — show both so
                  the reviewer sees WHY, and which figure matches QB. */}
              {bankDiffers && a.bankAmount != null ? (
                <span
                  className="font-medium text-foreground/80"
                  data-testid={`bank-amount-${a.anchorId}`}
                >
                  {" "}
                  · bank {formatCurrency(a.bankAmount)}
                </span>
              ) : (
                ""
              )}
            </div>
          )}
          {(tiesProposed > 0 || tiesConfirmed > 0) && (
            <div
              className="mt-0.5 text-[11px] text-muted-foreground"
              data-testid={`charge-ties-summary-${a.anchorId}`}
            >
              QB ties:{" "}
              {tiesConfirmed > 0 ? `${tiesConfirmed} confirmed` : ""}
              {tiesConfirmed > 0 && tiesProposed > 0 ? " · " : ""}
              {tiesProposed > 0 ? `${tiesProposed} proposed` : ""}
            </div>
          )}
          <ChargeList
            charges={a.charges}
            onRejectProposedQb={
              selectable ? handleRejectChargeTie : undefined
            }
            rejectingChargeId={rejectingChargeId}
            onTieCharge={selectable ? setTieCharge : undefined}
            // Untie is NOT gated on `selectable`: a fully-tied payout sits in
            // the read-only Matched column, and that's exactly where a wrong
            // confirmed tie is spotted and needs undoing.
            onUntieConfirmedQb={handleUntieChargeTie}
            untieingChargeId={untieingChargeId}
          />

          {/* Actions */}
          {selectable && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {showApproveTies && (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={busy}
                  onClick={handleApproveTies}
                  data-testid={`button-settlement-approve-ties-${a.anchorId}`}
                >
                  {busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Link2 className="h-3 w-3" />
                  )}
                  Approve {tiesProposed} QB tie{tiesProposed === 1 ? "" : "s"}
                </Button>
              )}
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

      {tieCharge && (
        <TieChargeQbDialog
          payoutId={a.anchorId}
          charge={tieCharge}
          open={tieCharge != null}
          onOpenChange={(v) => {
            if (!v) setTieCharge(null);
          }}
          onPick={handleTieChargePick}
          busy={busy}
        />
      )}
    </div>
  );
}
