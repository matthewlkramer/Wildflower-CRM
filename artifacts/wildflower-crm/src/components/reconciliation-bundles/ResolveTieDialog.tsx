import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import {
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

export interface ResultRow {
  id: string;
  primary: string;
  secondary: string | null;
  amount: string | null;
  date: string | null;
  /** Set when the row can't be picked (excluded / already settled / already
   *  tied) — shown as a label and the row disabled, never hidden, so users can
   *  spot (and help debug) a mis-derived status. */
  blockedReason: string | null;
  /** True only for deliberately overridable blockers (exclusion, and — on
   *  the per-charge tie dialog — an amount mismatch): the row stays clickable
   *  and a deliberate second click ties anyway. Settled/tied-elsewhere
   *  blockers are never overridable — overriding those would double-count
   *  money. */
  overridable?: boolean;
  /** The override flags the second (confirming) click sends. Defaults to
   *  `{ overrideExclusion: true }` for back-compat with exclusion-only rows. */
  overridePick?: PickOptions;
  /** Hint under an un-armed overridable row ("Click to override …"). */
  overrideHint?: string;
  /** Warning under an ARMED overridable row — say exactly what the second
   *  click will do. */
  armedHint?: string;
}

export interface PickOptions {
  /** The user deliberately picked a row that was excluded from review —
   *  the confirm should re-include it and tie in one transaction. */
  overrideExclusion?: boolean;
  /** The user deliberately picked a row whose amount matches neither the
   *  charge's gross nor its net — the confirm should tie it to the pinned
   *  charge anyway (charge-tie dialog only; requires the pinned chargeId). */
  overrideAmountMismatch?: boolean;
}

/**
 * "Resolve" search dialog: find and tie the correct QuickBooks deposit for a
 * Stripe payout when it has no good proposed match (or after a reject).
 * Mirrors the gift page's search-to-link flow. The Settlement report only
 * lists payout anchors, so the search is always QB-deposit-side (qb-staged
 * search). On pick, the caller ties the deposit and approves. The search hook
 * only runs while the dialog is open (Radix unmounts closed content).
 */
export function ResolveTieDialog({
  anchor,
  open,
  onOpenChange,
  onPick,
  busy = false,
}: {
  /** Only the anchor id + money context are needed, so callers outside the
   *  Settlement report (e.g. the cluster workbench) can pass a minimal shape. */
  anchor: Pick<BundleAnchor, "anchorId" | "amount" | "date">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (counterpartId: string, opts?: PickOptions) => void;
  busy?: boolean;
}) {
  const [q, setQ] = useState("");

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
          <DialogTitle>Find the QuickBooks deposit</DialogTitle>
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
            placeholder="Search deposits…"
            className="pl-8"
            disabled={busy}
            data-testid="input-resolve-search"
          />
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          <DepositResults
            q={q}
            amount={anchor.amount ?? null}
            date={anchor.date ?? null}
            busy={busy}
            onPick={onPick}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DepositResults({
  q,
  amount,
  date,
  busy,
  onPick,
}: {
  q: string;
  amount: string | null;
  date: string | null;
  busy: boolean;
  onPick: (id: string, opts?: PickOptions) => void;
}) {
  const { data, isFetching, isError } = useSearchReconciliationQbStaged({
    q: q.trim() || undefined,
    amount: amount ?? undefined,
    // Pass the anchor date so the server can rank by proximity to it; keep the
    // window wide (a year) so it orders rather than hides distant candidates.
    date: date ?? undefined,
    days: 365,
    limit: 25,
  });
  const rows: ResultRow[] = (data?.data ?? []).map((c) => ({
    id: c.id,
    primary: c.label ?? shortId(c.id),
    secondary: c.sublabel ?? null,
    amount: c.amount ?? null,
    date: c.date ?? null,
    blockedReason: c.conflictReason ?? null,
    // Only the exclusion blocker is click-to-override; settled/tied-elsewhere
    // rows stay hard-blocked (their money is already claimed).
    overridable: c.conflictKind === "excluded",
  }));
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

export function ResultsList({
  rows,
  isFetching,
  isError,
  busy,
  onPick,
  resetKey,
}: {
  rows: ResultRow[];
  isFetching: boolean;
  isError: boolean;
  busy: boolean;
  onPick: (id: string, opts?: PickOptions) => void;
  /** Changing this (e.g. the search query) disarms any armed override row so
   *  a stale arm never survives into a different result set. */
  resetKey?: string;
}) {
  // Two-click override arm: the first click on an overridable blocked row
  // arms it (the warning stays visible and the label asks for confirmation);
  // the second click ties anyway with overrideExclusion. Clicking any other
  // row disarms.
  const [armedId, setArmedId] = useState<string | null>(null);
  useEffect(() => {
    setArmedId(null);
  }, [resetKey]);
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
      {rows.map((r) => {
        const blocked = r.blockedReason != null;
        const canOverride = blocked && r.overridable === true;
        const armed = canOverride && armedId === r.id;
        return (
        <Button
          key={r.id}
          type="button"
          variant="outline"
          className={
            "h-auto w-full justify-between gap-2 whitespace-normal px-2 py-1.5 text-left disabled:opacity-60" +
            (armed ? " border-amber-500 bg-amber-500/10" : "")
          }
          disabled={busy || (blocked && !canOverride)}
          onClick={() => {
            if (!blocked) {
              setArmedId(null);
              onPick(r.id);
              return;
            }
            // Overridable blocked row: first click arms, second confirms
            // with the row's specific override flags.
            if (armed) {
              setArmedId(null);
              onPick(r.id, r.overridePick ?? { overrideExclusion: true });
            } else {
              setArmedId(r.id);
            }
          }}
          data-testid={`button-resolve-pick-${r.id}`}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{r.primary}</span>
            {r.secondary && (
              <span className="truncate text-xs text-muted-foreground">
                {r.secondary}
              </span>
            )}
            {r.blockedReason && (
              <span className="truncate text-xs text-amber-600">
                {r.blockedReason}
              </span>
            )}
            {armed ? (
              <span className="whitespace-normal text-xs font-medium text-amber-700">
                {r.armedHint ??
                  "Click again to tie anyway — this row will be put back into review and tied."}
              </span>
            ) : (
              canOverride && (
                <span className="truncate text-xs text-muted-foreground">
                  {r.overrideHint ?? "Click to override the exclusion."}
                </span>
              )
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
        );
      })}
    </>
  );
}
