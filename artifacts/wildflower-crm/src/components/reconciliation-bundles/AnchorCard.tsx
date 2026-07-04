import type { BundleAnchor, BundleAnchorType } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/format";
import { shortId } from "./bundle-ui";

const SOURCE_LABEL: Record<BundleAnchorType, string> = {
  stripe_payout: "Stripe",
  qb_staged_payment: "QuickBooks",
};

/**
 * Presentational settlement-anchor card, shared by the legacy BundleAnchorList
 * and the Settlement report's three columns. Selecting it loads the anchor's
 * draft in the detail pane.
 */
export function AnchorCard({
  anchor: a,
  selected,
  onSelect,
}: {
  anchor: BundleAnchor;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-md border p-2 text-left text-sm transition-colors",
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
      )}
      data-testid={`button-bundle-anchor-${a.anchorId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px] font-normal">
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
}
