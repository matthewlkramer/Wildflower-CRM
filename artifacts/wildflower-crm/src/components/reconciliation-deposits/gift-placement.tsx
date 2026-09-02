import { useEffect, useMemo, useState } from "react";
import type {
  GiftOrPayment,
  WorkbenchDeposit,
  WorkbenchDepositCompositionComponentsItem,
} from "@workspace/api-client-react";
import type { AnchorRef } from "@/components/reconciliation-clusters/actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";

export type GiftPlacementTarget = {
  key: string;
  anchor: AnchorRef;
  label: string;
  amount: string | null;
  date: string | null;
  currentGiftId: string | null;
};

export type GiftPlacementPlan = {
  targets: GiftPlacementTarget[];
  uniqueExactMatchKey: string | null;
  directTarget: GiftPlacementTarget | null;
  split: null | {
    bankDepositId: string;
    paymentCount: number;
    grossAmount: string;
    netAmount: string;
    feeAmount: string;
    giftMatches: "gross" | "net";
  };
};

const cents = (value: string | number | null | undefined) =>
  Math.round(Number(value ?? 0) * 100);

export function componentAnchor(
  deposit: WorkbenchDeposit,
  component: WorkbenchDepositCompositionComponentsItem,
): AnchorRef | null {
  if (component.paymentUnitId) {
    return {
      kind: "component",
      id: component.componentId,
      label: component.label ?? component.kind,
      bankDepositId: deposit.anchorId,
      amount: component.amount,
      paymentUnitId: component.paymentUnitId,
    };
  }
  if (component.stagedPaymentId && component.stagedActionable === true) {
    return {
      kind: "staged",
      id: component.stagedPaymentId,
      label: component.label ?? component.kind,
    };
  }
  return null;
}

function liveChargesOf(deposit: WorkbenchDeposit) {
  return deposit.charges.filter(
    (charge) =>
      !charge.exclusionReason &&
      !charge.refunded &&
      cents(charge.amountRefunded) === 0,
  );
}

function chargeTargetsOf(
  liveCharges: ReturnType<typeof liveChargesOf>,
  giftId: string | null,
): GiftPlacementTarget[] {
  return liveCharges
    .filter(
      (charge) =>
        !charge.linkedGiftId ||
        (giftId != null && charge.linkedGiftId === giftId),
    )
    .map((charge) => ({
      key: `charge:${charge.chargeId}`,
      anchor: {
        kind: "charge" as const,
        id: charge.chargeId,
        label: charge.payerName ?? charge.chargeId,
      },
      label: charge.payerName ?? charge.chargeId,
      amount: charge.amount ?? null,
      date: charge.chargeDate ?? null,
      currentGiftId: charge.linkedGiftId ?? null,
    }));
}

function componentTargetsOf(deposit: WorkbenchDeposit): GiftPlacementTarget[] {
  return deposit.composition.kind === "components"
    ? deposit.composition.components.flatMap((component) => {
        if (
          component.exclusionReason ||
          (component.countedGiftIds?.length ?? 0) > 0
        )
          return [];
        const anchor = componentAnchor(deposit, component);
        return anchor
          ? [
              {
                key: `${anchor.kind}:${anchor.id}`,
                anchor,
                label: component.label ?? component.kind,
                amount: component.amount,
                date: component.receivedDate ?? deposit.date ?? null,
                currentGiftId: null,
              },
            ]
          : [];
      })
    : [];
}

/**
 * The payments on a deposit row that can accept a new/linked gift, gift-free.
 * Charge targets always win when present (Stripe rows book per-charge; the
 * manual components under a payout are the same money, not extra targets).
 * Used by the pledge-payment pick, which has no gift yet: exactly 1 target
 * mints directly, several ask the human which payment, and there is no
 * whole-payout split for a pledge pick.
 */
export function extractPlacementTargets(
  deposit: WorkbenchDeposit,
  giftId?: string | null,
): GiftPlacementTarget[] {
  const chargeTargets = chargeTargetsOf(liveChargesOf(deposit), giftId ?? null);
  return chargeTargets.length ? chargeTargets : componentTargetsOf(deposit);
}

export function buildGiftPlacementPlan(
  deposit: WorkbenchDeposit,
  gift: GiftOrPayment,
): GiftPlacementPlan {
  const liveCharges = liveChargesOf(deposit);
  const chargeTargets = chargeTargetsOf(liveCharges, gift.id);
  const componentTargets = componentTargetsOf(deposit);

  const targets = chargeTargets.length ? chargeTargets : componentTargets;
  const exact = targets.filter(
    (target) => Math.abs(cents(target.amount) - cents(gift.amount)) <= 1,
  );
  const uniqueExactMatchKey = exact.length === 1 ? exact[0]!.key : null;
  const directTarget =
    targets.length === 1 && uniqueExactMatchKey === targets[0]!.key
      ? targets[0]!
      : null;

  let split: GiftPlacementPlan["split"] = null;
  if (
    deposit.composition.payoutId &&
    liveCharges.length > 1 &&
    chargeTargets.length === liveCharges.length
  ) {
    const normalizedPayers = new Set(
      liveCharges.map((charge) =>
        (charge.payerName ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .toLocaleLowerCase("en-US"),
      ),
    );
    const grossCents = liveCharges.reduce(
      (sum, charge) => sum + cents(charge.amount),
      0,
    );
    const netCents = cents(deposit.composition.netTotal ?? deposit.bank.amount);
    const feeCents = cents(deposit.composition.feeTotal);
    const refundCents = cents(deposit.composition.refundTotal);
    const adjustmentCents = cents(deposit.composition.adjustmentTotal);
    const giftCents = cents(gift.amount);
    const matchesGross = Math.abs(giftCents - grossCents) <= 1;
    const matchesNet =
      Math.abs(giftCents - netCents) <= 1 &&
      refundCents === 0 &&
      adjustmentCents === 0 &&
      Math.abs(grossCents - feeCents - netCents) <= 1;
    if (
      normalizedPayers.size === 1 &&
      !normalizedPayers.has("") &&
      (matchesGross || matchesNet)
    ) {
      split = {
        bankDepositId: deposit.anchorId,
        paymentCount: liveCharges.length,
        grossAmount: (grossCents / 100).toFixed(2),
        netAmount: (netCents / 100).toFixed(2),
        feeAmount: (feeCents / 100).toFixed(2),
        giftMatches: matchesGross ? "gross" : "net",
      };
    }
  }

  return { targets, uniqueExactMatchKey, directTarget, split };
}

export function GiftPlacementDialog({
  open,
  onOpenChange,
  gift,
  pledgeName,
  plan,
  busy,
  onLink,
  onSplit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gift: GiftOrPayment | null;
  /** Pledge-payment pick: which payment gets the minted gift (no split). */
  pledgeName?: string | null;
  plan: GiftPlacementPlan | null;
  busy: boolean;
  onLink: (target: GiftPlacementTarget) => void;
  onSplit: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    if (open) setSelectedKey(plan?.uniqueExactMatchKey ?? null);
  }, [open, plan?.uniqueExactMatchKey]);
  const selected = useMemo(
    () => plan?.targets.find((target) => target.key === selectedKey) ?? null,
    [plan?.targets, selectedKey],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="dialog-gift-placement">
        <DialogHeader>
          <DialogTitle>
            {pledgeName
              ? "Which payment pays this pledge?"
              : "Where should this gift go?"}
          </DialogTitle>
          <DialogDescription>
            {pledgeName ? (
              <>
                This row has several open payments. Pick the one to record as a
                payment on “{pledgeName}”.
              </>
            ) : (
              <>
                “{gift?.name ?? gift?.id}” is{" "}
                {formatCurrency(gift?.amount ?? "0")}. Choose the payment it
                belongs to, or use the payout split when this gift represents
                the whole Stripe batch.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!pledgeName && plan?.split ? (
          <div className="rounded-md border border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-800 dark:bg-emerald-950/20">
            <p className="text-sm font-semibold">
              This gift matches the whole payout.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {plan.split.paymentCount} payments total{" "}
              {formatCurrency(plan.split.grossAmount)}
              {plan.split.giftMatches === "net"
                ? `, less ${formatCurrency(plan.split.feeAmount)} in Stripe fees = ${formatCurrency(plan.split.netAmount)} deposited.`
                : "."}
            </p>
            <Button
              type="button"
              className="mt-3"
              disabled={busy}
              onClick={onSplit}
              data-testid="button-split-gift-across-charges"
            >
              Split into {plan.split.paymentCount} per-payment gifts and link
              all
            </Button>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Donor, gift date, pledge/campaign fields, and the single
              allocation’s designation are copied to every per-payment gift. The
              new gift amounts use Stripe’s gross charge amounts.
            </p>
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-xs font-medium">
            {pledgeName
              ? "Open payments on this row"
              : "Or link it to one payment"}
          </p>
          {plan?.targets.map((target) => (
            <button
              type="button"
              key={target.key}
              onClick={() => setSelectedKey(target.key)}
              disabled={busy}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left",
                selectedKey === target.key
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted/40",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {target.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {target.date ? formatDateShort(target.date) : "Undated"}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {target.currentGiftId === gift?.id ? (
                  <Badge variant="secondary">Already linked</Badge>
                ) : null}
                <span className="tabular-nums text-sm font-semibold">
                  {formatCurrency(target.amount ?? "0")}
                </span>
              </span>
            </button>
          ))}
          {plan?.targets.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No unlinked payment on this row can accept the selected gift.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !selected}
            onClick={() => selected && onLink(selected)}
            data-testid="button-link-gift-to-selected-payment"
          >
            {pledgeName
              ? "Record payment on pledge"
              : "Link to selected payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
