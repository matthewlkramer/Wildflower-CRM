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
    // Refresh the settlement-anchor list so the just-committed anchor drops out
    // of its queue (prefix-match across every queue variant, full "/api" key).
    void queryClient.invalidateQueries({
      queryKey: getListReconciliationBundleAnchorsQueryKey(),
    });
    // A bundle confirm reconciles the same staged payments / charges / gifts the
    // rest of the workbench renders, so the other queues must refresh too —
    // otherwise the just-confirmed money lingers in "Needs review" / QBO-only
    // until a hard reload. Mirrors the workbench's post-apply invalidation set.
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
    // A bundle confirm that matches an existing stray gift resolves it, so the
    // CRM-only "gifts missing QuickBooks" list + badge must refresh too.
    void queryClient.invalidateQueries({
      queryKey: ["/api/reconciliation/gifts-missing-qb"],
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
