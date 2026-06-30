import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListReconciliationBundleAnchorsQueryKey,
  type BundleAnchorType,
} from "@workspace/api-client-react";
import { BundleAnchorList } from "./BundleAnchorList";
import { BundleDraftPanel } from "./BundleDraftPanel";

interface SelectedAnchor {
  anchorType: BundleAnchorType;
  anchorId: string;
}

/**
 * Settlement-bundle reconciliation queue: a unified master list of settlement
 * anchors (Stripe payouts AND standalone QuickBooks deposits) on the left, and
 * the reactive draft for the selected anchor on the right. Confirming a bundle
 * refreshes the anchor list so the just-committed anchor drops out of its queue.
 */
export function BundleQueue() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<SelectedAnchor | null>(null);

  const handleSelect = useCallback(
    (anchorType: BundleAnchorType, anchorId: string) => {
      setSelected({ anchorType, anchorId });
    },
    [],
  );

  const handleConfirmed = useCallback(() => {
    // Prefix-match invalidation across every queue variant (full "/api" key).
    queryClient.invalidateQueries({
      queryKey: getListReconciliationBundleAnchorsQueryKey(),
    });
  }, [queryClient]);

  const selectedKey = selected
    ? `${selected.anchorType}:${selected.anchorId}`
    : null;

  return (
    <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
      <div className="min-h-0 rounded-lg border bg-card p-3">
        <BundleAnchorList selectedKey={selectedKey} onSelect={handleSelect} />
      </div>
      <div className="min-h-0 rounded-lg border bg-card p-3">
        {selected ? (
          <BundleDraftPanel
            key={selectedKey ?? undefined}
            anchorType={selected.anchorType}
            anchorId={selected.anchorId}
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
