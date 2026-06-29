import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  useListStripePayoutReconciliations,
  type StripePayoutReconciliationQueue,
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

const QUEUE_OPTIONS: { id: StripePayoutReconciliationQueue; label: string }[] = [
  { id: "proposed", label: "Proposed" },
  { id: "unmatched", label: "Unmatched" },
  { id: "conflict", label: "Conflicts" },
  { id: "confirmed", label: "Confirmed" },
  { id: "all", label: "All" },
];

/**
 * The master list of settlement anchors (Stripe payouts) to reconcile as a
 * bundle. Reuses the existing payout-reconciliation list endpoint — no new
 * enumeration route. Selecting a payout loads its draft in the detail pane.
 */
export function BundleAnchorList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (anchorId: string) => void;
}) {
  const [queue, setQueue] = useState<StripePayoutReconciliationQueue>("proposed");
  const { data, isLoading, isError } = useListStripePayoutReconciliations({
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
        <Select
          value={queue}
          onValueChange={(v) =>
            setQueue(v as StripePayoutReconciliationQueue)
          }
        >
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
            <AlertCircle className="h-4 w-4" /> Couldn't load payouts.
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No payouts in this queue.
          </div>
        ) : (
          rows.map((p) => {
            const selected = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                className={cn(
                  "w-full rounded-md border p-2 text-left text-sm transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/50",
                )}
                data-testid={`button-bundle-anchor-${p.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{shortId(p.id)}</span>
                  <span className="font-semibold">
                    {p.netTotal != null
                      ? formatCurrency(p.netTotal)
                      : p.amount != null
                        ? formatCurrency(p.amount)
                        : "—"}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {p.arrivalDate ? formatDate(p.arrivalDate) : "—"}
                    {p.chargeCount != null ? ` · ${p.chargeCount} charges` : ""}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {p.qbReconciliationStatus}
                  </Badge>
                </div>
                {p.depositPayerName && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {p.depositPayerName}
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
