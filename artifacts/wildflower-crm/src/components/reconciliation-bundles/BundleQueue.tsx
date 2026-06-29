import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListStripePayoutReconciliationsQueryKey } from "@workspace/api-client-react";
import { BundleAnchorList } from "./BundleAnchorList";
import { BundleDraftPanel } from "./BundleDraftPanel";

/**
 * Settlement-bundle reconciliation queue: a master list of settlement anchors
 * (Stripe payouts) on the left, and the reactive draft for the selected anchor
 * on the right. Confirming a bundle refreshes the anchor list so the just-
 * committed payout drops out of its queue.
 */
export function BundleQueue() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleConfirmed = useCallback(() => {
    // Prefix-match invalidation across every queue variant (full "/api" key).
    queryClient.invalidateQueries({
      queryKey: getListStripePayoutReconciliationsQueryKey(),
    });
  }, [queryClient]);

  return (
    <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
      <div className="min-h-0 rounded-lg border bg-card p-3">
        <BundleAnchorList selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <div className="min-h-0 rounded-lg border bg-card p-3">
        {selectedId ? (
          <BundleDraftPanel
            key={selectedId}
            anchorId={selectedId}
            onConfirmed={handleConfirmed}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a settlement anchor to assemble its bundle.
          </div>
        )}
      </div>
    </div>
  );
}
