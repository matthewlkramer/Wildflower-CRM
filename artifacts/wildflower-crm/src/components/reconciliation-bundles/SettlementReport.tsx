import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Loader2, X } from "lucide-react";
import {
  useAssembleReconciliationBundle,
  useConfirmReconciliationBundle,
  useDeriveReconciliationBundle,
  useListReconciliationBundleAnchors,
  useRejectSettlementProposal,
  getListReconciliationBundleAnchorsQueryKey,
  type BundleAnchor,
  type FlagForResearchBodyTargetType,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useRowSelection } from "@/hooks/use-row-selection";
import { BulkFlagForResearchDialog } from "@/components/flag-for-research-dialog";
import { SettlementCard } from "./SettlementCard";
import { approveAnchor, is409 } from "./settlement-actions";

/** Selection key for an anchor (stable across the two actionable columns). */
const anchorKey = (a: Pick<BundleAnchor, "anchorType" | "anchorId">) =>
  `${a.anchorType}:${a.anchorId}`;

/** Cleanup-queue flag target for an anchor (payout vs QB staged deposit). */
function flagTarget(a: BundleAnchor): {
  targetType: FlagForResearchBodyTargetType;
  targetId: string;
} {
  return {
    targetType:
      a.anchorType === "stripe_payout" ? "stripe_payout" : "staged_payment",
    targetId: a.anchorId,
  };
}

/**
 * Settlement report (design §4.5, Plane 1: Stripe payouts ↔ QB deposits),
 * reworked to the Gift report's card-first model. Anchors are bucketed into
 * three columns by derived batch status:
 *   • Matched        — a CONFIRMED settlement link (settled). Read-only.
 *   • Missing deposit — a Stripe payout with no confirmed deposit (may carry a
 *                       proposed match to approve/reject, else resolve).
 *   • Missing payout  — a standalone QB deposit with no payout (resolve).
 * The proposed match, its approve/reject/resolve controls, per-charge editing,
 * and multi-select bulk actions all live on the cards; the old below-columns
 * bundle box is retired. Approve reuses the atomic bundle-confirm path, so
 * committing refreshes every workbench query the bundle touches.
 */
export function SettlementReport() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const selection = useRowSelection();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);

  const assembleM = useAssembleReconciliationBundle();
  const deriveM = useDeriveReconciliationBundle();
  const confirmM = useConfirmReconciliationBundle();
  const rejectM = useRejectSettlementProposal();

  const { data, isLoading, isError } = useListReconciliationBundleAnchors({
    queue: "all",
    limit: 10000,
  });

  const rows = useMemo(() => data?.data ?? [], [data]);

  const { matched, missingDeposit, missingPayout } = useMemo(() => {
    const matched: BundleAnchor[] = [];
    const missingDeposit: BundleAnchor[] = [];
    const missingPayout: BundleAnchor[] = [];
    for (const a of rows) {
      // Only a CONFIRMED link is "Matched" (read-only). A `proposed` tie is
      // still actionable, so it stays in its source column with the proposal
      // shown inline on the card.
      if (a.batchStatus === "settled") {
        matched.push(a);
      } else if (a.anchorType === "stripe_payout") {
        missingDeposit.push(a);
      } else {
        missingPayout.push(a);
      }
    }
    return { matched, missingDeposit, missingPayout };
  }, [rows]);

  // Fast lookup for bulk actions over the selected keys.
  const byKey = useMemo(() => {
    const m = new Map<string, BundleAnchor>();
    for (const a of [...missingDeposit, ...missingPayout]) m.set(anchorKey(a), a);
    return m;
  }, [missingDeposit, missingPayout]);

  const selectedAnchors = useMemo(
    () =>
      selection.selectedIds
        .map((k) => byKey.get(k))
        .filter((a): a is BundleAnchor => a != null),
    [selection.selectedIds, byKey],
  );

  const invalidateWorkbench = useCallback(() => {
    // Drop just-committed anchors from their columns…
    void queryClient.invalidateQueries({
      queryKey: getListReconciliationBundleAnchorsQueryKey(),
    });
    // …and refresh the sibling queues a bundle confirm reconciles.
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

  const handleChanged = useCallback(() => {
    invalidateWorkbench();
  }, [invalidateWorkbench]);

  const fns = {
    assemble: assembleM.mutateAsync,
    derive: deriveM.mutateAsync,
    confirm: confirmM.mutateAsync,
  };

  const runBulkApprove = useCallback(async () => {
    const targets = selectedAnchors.filter((a) => a.proposedMatch);
    if (targets.length === 0) {
      toast({ title: "No proposed matches in the selection to approve." });
      return;
    }
    setBulkBusy(true);
    let approved = 0;
    let skipped = 0;
    let failed = 0;
    const done: string[] = [];
    for (const a of targets) {
      try {
        const outcome = await approveAnchor(a, fns);
        if (outcome === "approved") {
          approved += 1;
          done.push(anchorKey(a));
        } else {
          skipped += 1;
        }
      } catch (err) {
        if (is409(err)) skipped += 1;
        else failed += 1;
      }
    }
    setBulkBusy(false);
    selection.removeMany(done);
    invalidateWorkbench();
    toast({
      title: `Approved ${approved} settlement${approved === 1 ? "" : "s"}`,
      description:
        skipped + failed > 0
          ? `${skipped} needed review, ${failed} failed.`
          : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnchors, selection, invalidateWorkbench, toast]);

  const runBulkReject = useCallback(async () => {
    // Only Stripe-payout anchors carry a proposed link that can be rejected.
    const targets = selectedAnchors.filter(
      (a) => a.proposedMatch && a.anchorType === "stripe_payout",
    );
    if (targets.length === 0) {
      toast({ title: "No proposed matches in the selection to reject." });
      return;
    }
    setBulkBusy(true);
    let rejected = 0;
    let failed = 0;
    const done: string[] = [];
    for (const a of targets) {
      try {
        await rejectM.mutateAsync({ payoutId: a.anchorId });
        rejected += 1;
        done.push(anchorKey(a));
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    selection.removeMany(done);
    invalidateWorkbench();
    toast({
      title: `Rejected ${rejected} proposed match${rejected === 1 ? "" : "es"}`,
      description: failed > 0 ? `${failed} failed.` : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAnchors, selection, invalidateWorkbench, rejectM, toast]);

  const total = data?.pagination.total ?? rows.length;
  const truncated = !isLoading && !isError && total > rows.length;
  const busy = bulkBusy;

  return (
    <div className="flex flex-col gap-4">
      {truncated && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0" /> Showing {rows.length} of{" "}
          {total} settlement anchors — some rows are not listed.
        </div>
      )}

      {selection.count > 0 && (
        <div
          className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 shadow-sm"
          data-testid="settlement-bulk-bar"
        >
          <span className="text-sm font-medium" data-testid="settlement-bulk-count">
            {selection.count} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="gap-1"
              disabled={busy}
              onClick={runBulkApprove}
              data-testid="button-settlement-bulk-approve"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={busy}
              onClick={runBulkReject}
              data-testid="button-settlement-bulk-reject"
            >
              <X className="h-4 w-4" />
              Reject
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setFlagOpen(true)}
              data-testid="button-settlement-bulk-flag"
            >
              Flag for research
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={selection.clear}
              data-testid="button-settlement-bulk-clear"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Clear selection</span>
            </Button>
          </div>
        </div>
      )}

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
            hint="Payout ↔ deposit confirmed"
            rows={matched}
            selectable={false}
            selection={selection}
            onChanged={handleChanged}
          />
          <SettlementColumn
            title="Missing deposit"
            hint="Stripe payout, no confirmed deposit"
            rows={missingDeposit}
            selectable
            selection={selection}
            onChanged={handleChanged}
          />
          <SettlementColumn
            title="Missing payout"
            hint="QB deposit, no Stripe payout"
            rows={missingPayout}
            selectable
            selection={selection}
            onChanged={handleChanged}
          />
        </div>
      )}

      {flagOpen && (
        <BulkFlagForResearchDialog
          targets={selectedAnchors.map(flagTarget)}
          open={flagOpen}
          onOpenChange={setFlagOpen}
          onDone={() => {
            selection.clear();
            void queryClient.invalidateQueries({
              queryKey: getListReconciliationBundleAnchorsQueryKey(),
            });
          }}
        />
      )}
    </div>
  );
}

function SettlementColumn({
  title,
  hint,
  rows,
  selectable,
  selection,
  onChanged,
}: {
  title: string;
  hint: string;
  rows: BundleAnchor[];
  selectable: boolean;
  selection: ReturnType<typeof useRowSelection>;
  onChanged: () => void;
}) {
  const visibleKeys = useMemo(() => rows.map(anchorKey), [rows]);
  const allSelected =
    selectable &&
    visibleKeys.length > 0 &&
    visibleKeys.every((k) => selection.isSelected(k));

  return (
    <div className="flex min-h-0 flex-col rounded-lg border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2 border-b pb-2">
        <div className="flex items-center gap-2">
          {selectable && rows.length > 0 && (
            <Checkbox
              checked={allSelected}
              onCheckedChange={() => selection.toggleVisible(visibleKeys)}
              aria-label={`Select all ${title}`}
              data-testid={`checkbox-settlement-all-${title.replace(/\s+/g, "-").toLowerCase()}`}
            />
          )}
          <div className="flex flex-col">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {title}
            </span>
            <span className="text-[11px] text-muted-foreground/70">{hint}</span>
          </div>
        </div>
        <span className="text-xs font-semibold text-muted-foreground">
          {rows.length}
        </span>
      </div>
      <div className="mt-2 max-h-[60vh] min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            Nothing here.
          </div>
        ) : (
          rows.map((a) => {
            const key = anchorKey(a);
            return (
              <SettlementCard
                key={key}
                anchor={a}
                selectable={selectable}
                selected={selection.isSelected(key)}
                onToggleSelect={() => selection.toggle(key)}
                onChanged={onChanged}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
