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
import { ResultsList, type ResultRow } from "./ResolveTieDialog";
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
 * The server places a picked row onto an untied charge by EXACT amount, so
 * rows whose amount differs from this charge are shown grayed with that reason
 * (never hidden — the user should see and question a near-miss), alongside the
 * server-labeled blockers (excluded / settled elsewhere / already tied).
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
  onPick: (qbStagedPaymentId: string) => void;
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
            {shortId(payoutId)}. The row's amount must match the charge
            exactly.
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
  onPick: (id: string) => void;
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
  const rows: ResultRow[] = (data?.data ?? []).map((c) => {
    const amountMismatch =
      chargeCents != null && toCents(c.amount) !== chargeCents;
    return {
      id: c.id,
      primary: c.label ?? shortId(c.id),
      secondary: c.sublabel ?? null,
      amount: c.amount ?? null,
      date: c.date ?? null,
      // Server-labeled blockers win (excluded / settled / already tied);
      // otherwise gray a near-miss amount — the confirm assigns by exact
      // amount, so a differing row can never land on this charge.
      blockedReason:
        c.conflictReason ??
        (amountMismatch
          ? "Amount differs from the charge — an exact match is required"
          : null),
    };
  });
  return (
    <ResultsList
      rows={rows}
      isFetching={isFetching}
      isError={isError}
      busy={busy}
      onPick={onPick}
    />
  );
}
