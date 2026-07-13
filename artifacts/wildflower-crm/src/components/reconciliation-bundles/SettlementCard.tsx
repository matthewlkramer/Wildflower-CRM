import { useState } from "react";
import { Check, Link2, Loader2, Search, X } from "lucide-react";
import {
  useConfirmPayoutChargeTies,
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
import { decodeHtmlEntities, formatCurrency, formatDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { extractGateIssues } from "@/lib/reconciliation";
import { ResolveTieDialog } from "./ResolveTieDialog";
import {
  apiErrorCode,
  apiErrorMessage,
  is409,
  resolveConfirmArgs,
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

/** Deduped, trimmed, non-empty entries from a QB line-item text array. */
function uniqNonEmpty(values: string[] | null | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = decodeHtmlEntities(v).trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * QuickBooks descriptive context for a deposit anchor (or the proposed QB
 * counterpart of a Stripe payout): reference, memo/description, and a compact
 * summary of the deposit's line items (item names, account names, classes) so a
 * reviewer can eyeball the tie without leaving the card. Capped/scrollable for a
 * many-line deposit; renders nothing when there is no QB detail (e.g. a Stripe
 * payout anchor, whose QB fields are all null).
 */
export function QbDetails({
  lineDescription,
  memo,
  reference,
  lineItemNames,
  lineAccountNames,
  lineClasses,
}: {
  lineDescription?: string | null;
  memo?: string | null;
  reference?: string | null;
  lineItemNames?: string[] | null;
  lineAccountNames?: string[] | null;
  lineClasses?: string[] | null;
}) {
  const desc = decodeHtmlEntities(lineDescription ?? "").trim();
  const m = decodeHtmlEntities(memo ?? "").trim();
  const ref = (reference ?? "").trim();
  const items = uniqNonEmpty(lineItemNames);
  const accounts = uniqNonEmpty(lineAccountNames);
  const classes = uniqNonEmpty(lineClasses);
  if (
    !desc &&
    !m &&
    !ref &&
    items.length === 0 &&
    accounts.length === 0 &&
    classes.length === 0
  ) {
    return null;
  }
  return (
    <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto pr-1 text-[11px] leading-snug text-muted-foreground">
      {ref && <div className="truncate">Ref: {ref}</div>}
      {desc && <div className="truncate">{desc}</div>}
      {m && m !== desc && <div className="truncate">Memo: {m}</div>}
      {items.length > 0 && (
        <div className="truncate">Items: {items.join(", ")}</div>
      )}
      {accounts.length > 0 && (
        <div className="truncate">Accounts: {accounts.join(", ")}</div>
      )}
      {classes.length > 0 && (
        <div className="truncate">Classes: {classes.join(", ")}</div>
      )}
    </div>
  );
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
}: {
  charges: PayoutChargeSummary[] | undefined;
}) {
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
              <div className="flex items-center gap-1 text-[10px] text-emerald-700">
                <Link2 className="h-2.5 w-2.5 shrink-0" />
                QB tied
              </div>
            ) : c.proposedQb ? (
              <div
                className="text-[10px] text-sky-700"
                data-testid={`charge-proposed-qb-${c.id}`}
              >
                <span className="inline-flex items-center gap-1">
                  <Link2 className="h-2.5 w-2.5 shrink-0" />
                  Proposed QB:
                </span>{" "}
                {c.proposedQb.payerName?.trim() || "(no name)"}
                {c.proposedQb.amount != null
                  ? ` · ${formatCurrency(c.proposedQb.amount)}`
                  : ""}
                {c.proposedQb.date ? ` · ${formatDate(c.proposedQb.date)}` : ""}
                {c.proposedQb.memo?.trim() ? (
                  <span className="block truncate text-muted-foreground/70">
                    {decodeHtmlEntities(c.proposedQb.memo).trim()}
                  </span>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
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
  const chargeTiesM = useConfirmPayoutChargeTies();

  const [resolveOpen, setResolveOpen] = useState(false);

  const busy =
    confirmM.isPending || rejectM.isPending || chargeTiesM.isPending;
  const proposal = a.proposedMatch;
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
  const showApproveTies =
    a.anchorType === "stripe_payout" && tiesProposed > 0;

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
              : res.kind === "confirmed_linkage_only"
                ? "Settlement approved — the deposit was already booked, so only the link was recorded."
                : "Settlement approved.",
      });
      onChanged();
    } catch (err) {
      if (is409(err)) {
        // `deposit_not_booked` is a PERMANENT rejection — retrying will never
        // succeed, so don't present it as transient drift.
        if (apiErrorCode(err) === "deposit_not_booked") {
          toast({
            title: "Couldn't approve this settlement",
            description: apiErrorMessage(err) ?? errMessage(err),
            variant: "destructive",
          });
        } else {
          toast({
            title: "The settlement changed — refreshed.",
            description: apiErrorMessage(err) ?? errMessage(err),
          });
          onChanged();
        }
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
        if (apiErrorCode(err) === "deposit_not_booked") {
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
          {a.anchorType === "stripe_payout" &&
            (tiesProposed > 0 || tiesConfirmed > 0) && (
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
          <ChargeList charges={a.charges} />
          <QbDetails
            lineDescription={a.lineDescription}
            memo={a.memo}
            reference={a.reference}
            lineItemNames={a.lineItemNames}
            lineAccountNames={a.lineAccountNames}
            lineClasses={a.lineClasses}
          />

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
                {proposal.payerName ? ` · ${proposal.payerName}` : ""}
              </div>
              <QbDetails
                lineDescription={proposal.lineDescription}
                memo={proposal.memo}
                reference={proposal.reference}
                lineItemNames={proposal.lineItemNames}
                lineAccountNames={proposal.lineAccountNames}
                lineClasses={proposal.lineClasses}
              />
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
