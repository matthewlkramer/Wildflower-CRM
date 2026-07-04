import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  useListReconciliationBundleAnchors,
  getListReconciliationBundleAnchorsQueryKey,
  type BundleAnchor,
  type BundleAnchorQueue,
  type BundleAnchorType,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { AnchorCard } from "./AnchorCard";
import { BundleDraftPanel } from "./BundleDraftPanel";

interface SelectedAnchor {
  anchorType: BundleAnchorType;
  anchorId: string;
}

const FILTERS: { id: BundleAnchorQueue; label: string }[] = [
  { id: "needs_review", label: "Needs review" },
  { id: "confirmed", label: "Confirmed" },
  { id: "all", label: "All" },
];

/**
 * Settlement report (design §4.5, Plane 1: Stripe payouts ↔ QB deposits). The
 * same settlement anchors the legacy bundle queue enumerated, re-grouped into
 * three columns by the derived batch status (§4.4):
 *   • Matched        — a settlement link exists (settled or proposed).
 *   • Missing deposit — an orphan Stripe payout (money left Stripe, never booked).
 *   • Missing payout  — a standalone QB deposit with no tied payout.
 * "Needs review" / "Confirmed" are FILTERS over the same list (not queues).
 * Selecting an anchor assembles its bundle inline (BundleDraftPanel reused as-is);
 * confirming refreshes every workbench query the bundle touches.
 */
export function SettlementReport() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<BundleAnchorQueue>("needs_review");
  const [selected, setSelected] = useState<SelectedAnchor | null>(null);

  const { data, isLoading, isError } = useListReconciliationBundleAnchors({
    queue: filter,
    limit: 200,
  });

  const rows = useMemo(() => data?.data ?? [], [data]);

  const { matched, missingDeposit, missingPayout } = useMemo(() => {
    const matched: BundleAnchor[] = [];
    const missingDeposit: BundleAnchor[] = [];
    const missingPayout: BundleAnchor[] = [];
    for (const a of rows) {
      if (a.batchStatus === "settled" || a.batchStatus === "proposed") {
        matched.push(a);
      } else if (a.anchorType === "stripe_payout") {
        missingDeposit.push(a);
      } else {
        missingPayout.push(a);
      }
    }
    return { matched, missingDeposit, missingPayout };
  }, [rows]);

  const handleSelect = useCallback(
    (anchorType: BundleAnchorType, anchorId: string) => {
      setSelected({ anchorType, anchorId });
    },
    [],
  );

  const handleConfirmed = useCallback(() => {
    setSelected(null);
    // Refresh the settlement-anchor list so the just-committed anchor drops out
    // of its column (prefix-match across every filter variant, full "/api" key).
    void queryClient.invalidateQueries({
      queryKey: getListReconciliationBundleAnchorsQueryKey(),
    });
    // A bundle confirm reconciles the same staged payments / charges / gifts the
    // rest of the workbench renders, so the other queues must refresh too.
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey?.[0];
        return (
          typeof key === "string" && key.startsWith("/api/reconciliation/cards")
        );
      },
    });
    void queryClient.invalidateQueries({ queryKey: ["/api/staged-payments"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/gifts-and-payments"] });
    void queryClient.invalidateQueries({
      queryKey: ["/api/reconciliation/gifts-missing-qb"],
    });
  }, [queryClient]);

  const selectedKey = selected
    ? `${selected.anchorType}:${selected.anchorId}`
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Filter
        </span>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs transition-colors",
              filter === f.id
                ? "border-primary bg-primary/5 font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/50",
            )}
            data-testid={`button-settlement-filter-${f.id}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isError ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="h-4 w-4" /> Couldn't load settlement anchors.
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <SettlementColumn
            title="Matched"
            hint="Payout ↔ deposit linked"
            rows={matched}
            selectedKey={selectedKey}
            onSelect={handleSelect}
          />
          <SettlementColumn
            title="Missing deposit"
            hint="Stripe payout, no QB deposit"
            rows={missingDeposit}
            selectedKey={selectedKey}
            onSelect={handleSelect}
          />
          <SettlementColumn
            title="Missing payout"
            hint="QB deposit, no Stripe payout"
            rows={missingPayout}
            selectedKey={selectedKey}
            onSelect={handleSelect}
          />
        </div>
      )}

      {selected && (
        <div className="min-h-0 rounded-lg border bg-card p-3">
          <BundleDraftPanel
            key={selectedKey ?? undefined}
            anchorType={selected.anchorType}
            anchorId={selected.anchorId}
            onConfirmed={handleConfirmed}
          />
        </div>
      )}
    </div>
  );
}

function SettlementColumn({
  title,
  hint,
  rows,
  selectedKey,
  onSelect,
}: {
  title: string;
  hint: string;
  rows: BundleAnchor[];
  selectedKey: string | null;
  onSelect: (anchorType: BundleAnchorType, anchorId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-lg border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2 border-b pb-2">
        <div className="flex flex-col">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          <span className="text-[11px] text-muted-foreground/70">{hint}</span>
        </div>
        <span className="text-xs font-semibold text-muted-foreground">
          {rows.length}
        </span>
      </div>
      <div className="mt-2 max-h-[52vh] min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            Nothing here.
          </div>
        ) : (
          rows.map((a) => {
            const key = `${a.anchorType}:${a.anchorId}`;
            return (
              <AnchorCard
                key={key}
                anchor={a}
                selected={key === selectedKey}
                onSelect={() => onSelect(a.anchorType, a.anchorId)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
