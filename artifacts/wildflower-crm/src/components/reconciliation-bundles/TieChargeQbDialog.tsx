import { useState } from "react";
import { Search } from "lucide-react";
import {
  useSearchReconciliationQbStaged,
  type PayoutChargeSummary,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { decodeHtmlEntities, formatCurrency, formatDate } from "@/lib/format";
import {
  ResultsList,
  type PickOptions,
  type ResultRow,
} from "./ResolveTieDialog";
import { shortId } from "./bundle-ui";

/** Major-unit string → integer cents, null when unparseable. */
function toCents(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Manual charge-grain tie: find the QuickBooks row recording the SAME money as
 * ONE Stripe charge of an individually-booked payout — the missing-affordance
 * counterpart to the system-proposed ties' Approve/Reject. Used when the
 * proposal pass found nothing for a charge (or the human rejected it): search
 * QB staged rows near the charge's amount/date, pick the right one, and the
 * caller confirms it via the charge-ties endpoint's manual mode.
 *
 * The confirm is PINNED to this charge (the caller sends chargeId), and the
 * row's amount normally must EXACTLY equal the charge's GROSS (donation
 * amount) or NET (post-fee bank deposit), to the cent. Rows matching neither
 * are labeled with that reason (never hidden — the user should see and
 * question a near-miss) but stay overridable with a deliberate second click
 * (overrideAmountMismatch) — the bookkeeper sometimes booked a partial or
 * adjusted amount. Server-labeled blockers (settled elsewhere / already
 * tied) stay hard-blocked; an exclusion is overridable as before.
 * Plane 1 only: a tie is settlement evidence — no gift is minted or changed.
 */
export function TieChargeQbDialog({
  payoutId,
  charge,
  open,
  onOpenChange,
  onPick,
  busy = false,
}: {
  payoutId: string;
  charge: PayoutChargeSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qbStagedPaymentId: string, opts?: PickOptions) => void;
  busy?: boolean;
}) {
  const [q, setQ] = useState("");
  const payer = decodeHtmlEntities(charge.payerName ?? "").trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        if (!v) setQ("");
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Find the QuickBooks row for this charge</DialogTitle>
          <DialogDescription>
            Tie the QuickBooks row recording the same donation as{" "}
            {payer || shortId(charge.id)}
            {charge.amount != null
              ? ` (${formatCurrency(charge.amount)}`
              : " ("}
            {charge.date ? ` · ${formatDate(charge.date)})` : ")"} on payout{" "}
            {shortId(payoutId)}. The row's amount normally must exactly match
            the charge's gross
            {charge.net != null && charge.net !== charge.amount
              ? ` or net (${formatCurrency(charge.net)})`
              : ""}{" "}
            amount — a differently-booked row can be tied with a deliberate
            second click.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search QuickBooks rows…"
            className="pl-8"
            disabled={busy}
            data-testid="input-tie-charge-search"
          />
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          <QbRowResults q={q} charge={charge} busy={busy} onPick={onPick} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QbRowResults({
  q,
  charge,
  busy,
  onPick,
}: {
  q: string;
  charge: PayoutChargeSummary;
  busy: boolean;
  onPick: (id: string, opts?: PickOptions) => void;
}) {
  const { data, isFetching, isError } = useSearchReconciliationQbStaged({
    q: q.trim() || undefined,
    // The charge GROSS is what an individually-booked QB row records (the
    // donation amount before Stripe's fee) — band/rank the search around it.
    amount: charge.amount ?? undefined,
    // Rank by proximity to the charge date; keep the window wide (a year) so
    // it orders rather than hides distant candidates.
    date: charge.date ?? undefined,
    days: 365,
    limit: 25,
  });
  const chargeCents = toCents(charge.amount);
  const netCents = toCents(charge.net);
  const rows: ResultRow[] = (data?.data ?? []).map((c) => {
    const rowCents = toCents(c.amount);
    // The confirm accepts an exact match on the charge GROSS or NET (the
    // bookkeeper may have booked the post-fee bank deposit) — to the cent.
    const amountMismatch =
      chargeCents != null &&
      rowCents !== chargeCents &&
      (netCents == null || rowCents !== netCents);
    const excluded = c.conflictKind === "excluded";
    // Settled/tied-elsewhere rows are never overridable (their money is
    // already claimed). An exclusion and/or an amount mismatch ARE
    // deliberately overridable — the tie is pinned to THIS charge, so the
    // human can assert "this row records this charge's money" even when the
    // bookkeeper booked a different amount (e.g. a partial or adjusted
    // booking). Each blocker contributes its own explicit override flag.
    const hardBlocked = c.conflictReason != null && !excluded;
    const overridable = !hardBlocked && (excluded || amountMismatch);
    return {
      id: c.id,
      primary: c.label ?? shortId(c.id),
      secondary: c.sublabel ?? null,
      amount: c.amount ?? null,
      date: c.date ?? null,
      // Server-labeled blockers win (excluded / settled / already tied);
      // otherwise label a near-miss amount so the user sees WHY it needs an
      // override (rows are never hidden).
      blockedReason:
        c.conflictReason ??
        (amountMismatch
          ? "Amount matches neither the charge's gross nor its net"
          : null),
      overridable,
      overridePick: overridable
        ? {
            ...(excluded ? { overrideExclusion: true } : {}),
            ...(amountMismatch ? { overrideAmountMismatch: true } : {}),
          }
        : undefined,
      overrideHint: overridable
        ? excluded && amountMismatch
          ? "Click to override the exclusion and the amount check."
          : amountMismatch
            ? "Click to override the amount check."
            : "Click to override the exclusion."
        : undefined,
      armedHint: overridable
        ? amountMismatch
          ? excluded
            ? "Click again to tie anyway — this row returns to review and is tied to this charge despite the different amount."
            : "Click again to tie anyway — you're asserting this row records this charge's money despite the different amount."
          : "Click again to tie anyway — this row will be put back into review and tied."
        : undefined,
    };
  });
  return (
    <ResultsList
      rows={rows}
      isFetching={isFetching}
      isError={isError}
      busy={busy}
      onPick={onPick}
      resetKey={q}
    />
  );
}
