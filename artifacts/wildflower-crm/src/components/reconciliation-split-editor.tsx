import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Plus, X } from "lucide-react";
import {
  searchReconciliationNode,
  type ReconciliationCandidate,
  type SplitStagedPaymentBody,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import { useDebounce } from "@/hooks/use-debounce";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";

// ─── Split-across-gifts editor ────────────────────────────────────────────────
// Shared by the queue workbench (stages the split into its local tray) and the
// cluster workbench (submits the split directly). The dialog itself only builds
// the SplitStagedPaymentBody — what happens on "stage" is the caller's choice.

/** The staged QB payment being split, reduced to display + search fields. */
export interface SplitAnchorInfo {
  stagedPaymentId: string;
  amount: string | null;
  payerName: string | null;
  dateReceived: string | null;
  paymentMethod: string | null;
  reference: string | null;
}

function num(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v: string | null | undefined): string {
  const n = num(v);
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const FEE_BAND_FLOOR = 0.9;
const FEE_BAND_CEIL = 1.1;

/** Does the applied total sit inside the processor fee-band the split endpoint accepts? */
export function withinFeeBand(applied: number, total: number): boolean {
  if (total <= 0) return Math.abs(applied) < 0.005;
  return (
    applied >= total * FEE_BAND_FLOOR - 1 &&
    applied <= total * FEE_BAND_CEIL + 1
  );
}

/**
 * When the gift (gross) exceeds the QB deposit (net) by an amount that sits
 * inside the processor fee-band, that difference IS the processor fee, not an
 * over-application. Returns the fee, else null.
 */
export function feeRemainder(
  paymentTotal: number | null,
  applied: number | null,
): number | null {
  if (paymentTotal == null || applied == null) return null;
  if (applied <= paymentTotal) return null;
  if (!withinFeeBand(applied, paymentTotal)) return null;
  return +(applied - paymentTotal).toFixed(2);
}

// ─── Balance meter ────────────────────────────────────────────────────────────

export function BalanceMeter({
  paymentTotal,
  applied,
}: {
  paymentTotal: number | null;
  applied: number | null;
}) {
  if (paymentTotal == null || applied == null) return null;

  const remainder = +(paymentTotal - applied).toFixed(2);
  const balanced = Math.abs(remainder) < 0.005;
  // When the applied amount exceeds the payment by an amount inside the processor
  // fee-band, that gap is the processor fee (gift is gross, deposit is net) —
  // not an over-application error.
  const fee = feeRemainder(paymentTotal, applied);
  const isFee = fee != null;
  // `applied` is larger than the payment and the gap isn't a processor fee.
  const over = remainder < -0.005 && !isFee;
  const overBy = +(-remainder).toFixed(2);

  const tone: "emerald" | "sky" | "red" | "amber" = over
    ? "red"
    : balanced
      ? "emerald"
      : isFee
        ? "sky"
        : "amber";
  const toneBox = {
    emerald: "border-emerald-200 bg-emerald-50/60",
    sky: "border-sky-200 bg-sky-50/60",
    red: "border-red-200 bg-red-50/60",
    amber: "border-amber-200 bg-amber-50/60",
  }[tone];
  const toneBar = {
    emerald: "bg-emerald-500",
    sky: "bg-sky-500",
    red: "bg-red-500",
    amber: "bg-amber-500",
  }[tone];
  const toneText = {
    emerald: "text-emerald-700",
    sky: "text-sky-700",
    red: "text-red-700",
    amber: "text-amber-700",
  }[tone];

  // Full bar when over-applied; otherwise the applied/payment ratio.
  const pct = over
    ? 100
    : paymentTotal > 0
      ? Math.max(0, Math.min(100, (applied / paymentTotal) * 100))
      : applied > 0
        ? 100
        : 0;
  return (
    <div className="px-3 pb-2">
      <div className={cn("rounded-lg border p-3 text-[12.5px]", toneBox)}>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-muted-foreground">Applied</span>
          <span className="font-semibold">{money(String(applied))}</span>
        </div>
        <div className="my-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all", toneBar)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-muted-foreground">Payment total</span>
          <span className="font-semibold">{money(String(paymentTotal))}</span>
        </div>
        <div
          className={cn(
            "mt-2 flex items-center gap-1.5 font-semibold",
            toneText,
          )}
        >
          {over ? (
            <>
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Over-applied by{" "}
              {money(String(overBy))}
            </>
          ) : balanced ? (
            <>
              <Check className="h-3.5 w-3.5" /> Balances — applied equals
              payment
            </>
          ) : isFee ? (
            <>
              <Check className="h-3.5 w-3.5" /> {money(String(fee))} fee — gift
              is gross; deposit is net of the processor fee
            </>
          ) : (
            <>
              <AlertCircle className="h-3.5 w-3.5" /> {money(String(remainder))}{" "}
              unapplied — route the remainder
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact summary of the money event being split, pinned at the top of the
// dialog so the operator doesn't have to flip back to the card to recall its
// amount / date / payer.
function AnchorSummary({ anchor }: { anchor: SplitAnchorInfo }) {
  return (
    <div
      className="rounded-md border bg-muted/40 px-3 py-2"
      data-testid="anchor-payment-summary"
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Splitting this payment
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <span className="font-medium">{anchor.payerName ?? "Unknown payer"}</span>
        <span className="font-semibold tabular-nums">{money(anchor.amount)}</span>
        <span className="text-muted-foreground">
          {anchor.dateReceived ? formatDateShort(anchor.dateReceived) : "No date"}
        </span>
        {anchor.paymentMethod && (
          <span className="text-xs text-muted-foreground">
            {anchor.paymentMethod}
          </span>
        )}
      </div>
      {anchor.reference && (
        <div
          className="mt-0.5 truncate text-xs text-muted-foreground"
          title={anchor.reference}
        >
          {anchor.reference}
        </div>
      )}
    </div>
  );
}

export function SplitEditorDialog({
  anchor,
  busy = false,
  stageLabel = "Stage split",
  onClose,
  onStage,
}: {
  anchor: SplitAnchorInfo;
  /** Disables the submit button while the caller is applying the split. */
  busy?: boolean;
  /** Submit-button label — "Stage split" in the queue workbench, "Split payment" when submitting directly. */
  stageLabel?: string;
  onClose: () => void;
  onStage: (body: SplitStagedPaymentBody, detail: string) => void;
}) {
  const paymentTotal = num(anchor.amount);
  const [rows, setRows] = useState<ReconciliationCandidate[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ReconciliationCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const debouncedQ = useDebounce(q.trim());
  // Monotonic sequence so a slow earlier response can never clobber the
  // results of a newer (debounced) search.
  const searchSeq = useRef(0);

  const [remainderOn, setRemainderOn] = useState(false);
  const [remAmount, setRemAmount] = useState("");
  const [remDonorType, setRemDonorType] = useState<DonorType>("organization");
  const [remDonorId, setRemDonorId] = useState<string | null>(null);

  const runSearch = useCallback(
    async (query: string) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const res = await searchReconciliationNode("gift", {
          stagedPaymentId: anchor.stagedPaymentId,
          q: query || undefined,
          split: true,
          limit: 20,
        });
        if (seq === searchSeq.current) setResults(res.data ?? []);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [anchor.stagedPaymentId],
  );

  // Auto-search: on open (empty query → split-fraction candidates for this
  // payment) and as the user types (debounced).
  useEffect(() => {
    void runSearch(debouncedQ);
  }, [debouncedQ, runSearch]);

  const addRow = useCallback((gift: ReconciliationCandidate) => {
    setRows((prev) =>
      prev.some((r) => r.id === gift.id) ? prev : [...prev, gift],
    );
  }, []);
  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const appliedExisting = rows.reduce(
    (sum, r) => sum + (num(r.amount) ?? 0),
    0,
  );
  const remAmountNum = remainderOn ? (num(remAmount) ?? 0) : 0;
  const applied = appliedExisting + remAmountNum;
  const linkCount = rows.length + (remainderOn ? 1 : 0);

  const suggestRemainder = useCallback(() => {
    if (paymentTotal == null) return;
    const leftover = Math.max(0, paymentTotal - appliedExisting);
    setRemAmount(leftover.toFixed(2));
  }, [paymentTotal, appliedExisting]);

  const remainderValid =
    !remainderOn || (remAmountNum > 0 && remDonorId != null);
  const amountOk = paymentTotal != null && withinFeeBand(applied, paymentTotal);
  const canStage = linkCount >= 2 && remainderValid && amountOk && !busy;

  const handleStage = useCallback(() => {
    if (!canStage) return;
    const donorFields: {
      organizationId?: string | null;
      individualGiverPersonId?: string | null;
      householdId?: string | null;
    } =
      remDonorType === "organization"
        ? { organizationId: remDonorId }
        : remDonorType === "individual"
          ? { individualGiverPersonId: remDonorId }
          : { householdId: remDonorId };
    const body: SplitStagedPaymentBody = {
      giftIds: rows.map((r) => r.id),
      ...(remainderOn
        ? {
            remainderGift: {
              amount: remAmountNum.toFixed(2),
              ...donorFields,
            },
          }
        : {}),
    };
    const detail = `Split across ${linkCount} gifts${remainderOn ? " (incl. new remainder gift)" : ""}`;
    onStage(body, detail);
  }, [
    canStage,
    rows,
    remainderOn,
    remAmountNum,
    remDonorType,
    remDonorId,
    linkCount,
    onStage,
  ]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Split payment across gifts</DialogTitle>
          <DialogDescription>
            Link two or more existing gifts and/or a new remainder gift. Each
            existing gift is applied at its own booked amount.
          </DialogDescription>
        </DialogHeader>
        <AnchorSummary anchor={anchor} />

        {/* Application rows — existing gifts */}
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Applied to gifts
          </div>
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">
              No gifts added yet — search below and add at least two links.
            </p>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.label}</div>
                  {(r.sublabel || r.date) && (
                    <div className="truncate text-xs text-muted-foreground">
                      {[r.sublabel, r.date ? formatDateShort(r.date) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  )}
                </div>
                <span className="tabular-nums">{money(r.amount)}</span>
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Gift search */}
        <div className="relative">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search donor or gift name…"
            className="pr-9"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        {results.length > 0 && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1">
            {results.map((g) => {
              const linked = g.alreadyLinkedStagedPaymentId != null;
              const added = rows.some((r) => r.id === g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  disabled={linked || added}
                  onClick={() => addRow(g)}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm",
                    linked || added
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-muted",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {g.label}
                    </span>
                    {(g.sublabel || g.date) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {[g.sublabel, g.date ? formatDateShort(g.date) : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                  <span className="ml-2 flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground">
                    {money(g.amount)}
                    {linked ? (
                      <span className="text-[10px]">(linked)</span>
                    ) : added ? (
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Remainder → new gift */}
        <div className="rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={remainderOn}
              onCheckedChange={(v) => {
                const on = v === true;
                setRemainderOn(on);
                if (on) suggestRemainder();
              }}
            />
            Route remainder to a new gift
          </label>
          {remainderOn && (
            <div className="mt-3 space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <div className="mb-1 text-xs text-muted-foreground">
                    Remainder amount
                  </div>
                  <Input
                    value={remAmount}
                    onChange={(e) => setRemAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={suggestRemainder}
                >
                  Use leftover
                </Button>
              </div>
              <div>
                <div className="mb-1 text-xs text-muted-foreground">
                  New gift donor
                </div>
                <DonorFieldPicker
                  type={remDonorType}
                  id={remDonorId}
                  onChange={(t, id) => {
                    setRemDonorType(t);
                    setRemDonorId(id);
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Balance meter */}
        <div className="rounded-md border">
          <BalanceMeter paymentTotal={paymentTotal} applied={applied} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleStage} disabled={!canStage}>
            {busy ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Splitting…
              </>
            ) : canStage ? (
              stageLabel
            ) : (
              "Balance to enable"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
