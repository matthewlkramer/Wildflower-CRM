import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  useListReconciliationBundleAnchors,
  type BundleAnchorQueue,
  type BundleAnchorType,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { shortId } from "./bundle-ui";

const QUEUE_OPTIONS: { id: BundleAnchorQueue; label: string }[] = [
  { id: "needs_review", label: "Needs review" },
  { id: "confirmed", label: "Confirmed" },
  { id: "all", label: "All" },
];

const SOURCE_LABEL: Record<BundleAnchorType, string> = {
  stripe_payout: "Stripe",
  qb_staged_payment: "QuickBooks",
};

/**
 * The master list of settlement anchors to reconcile as a bundle. Unified across
 * BOTH sources — Stripe payouts AND standalone QuickBooks deposits/payments — via
 * the deduped /reconciliation/bundle-anchors endpoint (a QB deposit tied to a
 * payout is omitted; it flows through the payout's bundle). Selecting an anchor
 * loads its draft in the detail pane.
 */
export function BundleAnchorList({
  selectedKey,
  onSelect,
}: {
  selectedKey: string | null;
  onSelect: (anchorType: BundleAnchorType, anchorId: string) => void;
}) {
  const [queue, setQueue] = useState<BundleAnchorQueue>("needs_review");
  const { data, isLoading, isError } = useListReconciliationBundleAnchors({
    queue,
    limit: 200,
  });

  const rows = data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b pb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Settlement anchors
        </span>
        <Select value={queue} onValueChange={(v) => setQueue(v as BundleAnchorQueue)}>
          <SelectTrigger className="h-7 w-32 text-xs" data-testid="select-bundle-queue">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QUEUE_OPTIONS.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertCircle className="h-4 w-4" /> Couldn't load anchors.
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No anchors in this queue.
          </div>
        ) : (
          rows.map((a) => {
            const key = `${a.anchorType}:${a.anchorId}`;
            const selected = key === selectedKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelect(a.anchorType, a.anchorId)}
                className={cn(
                  "w-full rounded-md border p-2 text-left text-sm transition-colors",
                  selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                )}
                data-testid={`button-bundle-anchor-${a.anchorId}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <Badge
                      variant="secondary"
                      className="text-[10px] font-normal"
                    >
                      {SOURCE_LABEL[a.anchorType]}
                    </Badge>
                    <span className="font-medium">{shortId(a.anchorId)}</span>
                  </span>
                  <span className="font-semibold">
                    {a.amount != null ? formatCurrency(a.amount) : "—"}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {a.date ? formatDate(a.date) : "—"}
                    {a.chargeCount != null ? ` · ${a.chargeCount} charges` : ""}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {a.statusLabel}
                  </Badge>
                </div>
                {a.payerName && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {a.payerName}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
