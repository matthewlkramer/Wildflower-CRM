import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import {
  useSearchReconciliationPayouts,
  useSearchReconciliationQbStaged,
  type BundleAnchor,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/format";
import { shortId } from "./bundle-ui";

interface ResultRow {
  id: string;
  primary: string;
  secondary: string | null;
  amount: string | null;
  date: string | null;
}

/**
 * "Resolve" search dialog: find and tie the correct settlement counterpart when
 * an anchor has no good proposed match (or after a reject). Mirrors the gift
 * page's search-to-link flow. Direction is driven by the anchor:
 *   • qb_staged_payment anchor → search Stripe payouts (payout-search)
 *   • stripe_payout anchor      → search QuickBooks deposits (qb-staged search)
 * On pick, the caller ties the counterpart and approves. The search hooks only
 * run while the dialog is open (Radix unmounts closed content).
 */
export function ResolveTieDialog({
  anchor,
  open,
  onOpenChange,
  onPick,
  busy = false,
}: {
  anchor: BundleAnchor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (counterpartId: string) => void;
  busy?: boolean;
}) {
  const [q, setQ] = useState("");
  const searchingPayouts = anchor.anchorType === "qb_staged_payment";

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
          <DialogTitle>
            {searchingPayouts
              ? "Find the Stripe payout"
              : "Find the QuickBooks deposit"}
          </DialogTitle>
          <DialogDescription>
            Tie the correct counterpart to {shortId(anchor.anchorId)}
            {anchor.amount != null ? ` (${formatCurrency(anchor.amount)})` : ""},
            then approve.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchingPayouts ? "Search payouts…" : "Search deposits…"}
            className="pl-8"
            disabled={busy}
            data-testid="input-resolve-search"
          />
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {searchingPayouts ? (
            <PayoutResults
              q={q}
              amount={anchor.amount ?? null}
              busy={busy}
              onPick={onPick}
            />
          ) : (
            <DepositResults
              q={q}
              amount={anchor.amount ?? null}
              busy={busy}
              onPick={onPick}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PayoutResults({
  q,
  amount,
  busy,
  onPick,
}: {
  q: string;
  amount: string | null;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  const { data, isFetching, isError } = useSearchReconciliationPayouts({
    q: q.trim() || undefined,
    amount: amount ?? undefined,
    limit: 25,
  });
  const rows: ResultRow[] = (data?.data ?? []).map((c) => ({
    id: c.id,
    primary: shortId(c.id),
    secondary: c.chargeCount != null ? `${c.chargeCount} charges` : null,
    amount: c.amount ?? null,
    date: c.date ?? null,
  }));
  return (
    <ResultsList rows={rows} isFetching={isFetching} isError={isError} busy={busy} onPick={onPick} />
  );
}

function DepositResults({
  q,
  amount,
  busy,
  onPick,
}: {
  q: string;
  amount: string | null;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  const { data, isFetching, isError } = useSearchReconciliationQbStaged({
    q: q.trim() || undefined,
    amount: amount ?? undefined,
    limit: 25,
  });
  const rows: ResultRow[] = (data?.data ?? []).map((c) => ({
    id: c.id,
    primary: c.label ?? shortId(c.id),
    secondary: c.sublabel ?? null,
    amount: c.amount ?? null,
    date: null,
  }));
  return (
    <ResultsList rows={rows} isFetching={isFetching} isError={isError} busy={busy} onPick={onPick} />
  );
}

function ResultsList({
  rows,
  isFetching,
  isError,
  busy,
  onPick,
}: {
  rows: ResultRow[];
  isFetching: boolean;
  isError: boolean;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  if (isError) {
    return (
      <p className="py-6 text-center text-xs text-destructive">
        Couldn't search — try again.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-center text-xs text-muted-foreground">
        {isFetching ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
          </>
        ) : (
          "No candidates found."
        )}
      </p>
    );
  }
  return (
    <>
      {rows.map((r) => (
        <Button
          key={r.id}
          type="button"
          variant="outline"
          className="h-auto w-full justify-between gap-2 whitespace-normal px-2 py-1.5 text-left"
          disabled={busy}
          onClick={() => onPick(r.id)}
          data-testid={`button-resolve-pick-${r.id}`}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{r.primary}</span>
            {r.secondary && (
              <span className="truncate text-xs text-muted-foreground">
                {r.secondary}
              </span>
            )}
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <span className="text-sm font-semibold">
              {r.amount != null ? formatCurrency(r.amount) : "—"}
            </span>
            {r.date && (
              <span className="text-xs text-muted-foreground">
                {formatDate(r.date)}
              </span>
            )}
          </span>
        </Button>
      ))}
    </>
  );
}
