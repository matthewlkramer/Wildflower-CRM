import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import {
  useConfirmPayoutChargeTies,
  useConfirmSettlementLink,
  useListReconciliationBundleAnchors,
  useRejectSettlementProposal,
  getListReconciliationBundleAnchorsQueryKey,
  type BundleAnchor,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useRowSelection } from "@/hooks/use-row-selection";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { BulkFlagForResearchDialog } from "@/components/flag-for-research-dialog";
import { SettlementCard } from "./SettlementCard";
import { is409 } from "./settlement-actions";

/** Selection key for an anchor. */
const anchorKey = (a: Pick<BundleAnchor, "anchorType" | "anchorId">) =>
  `${a.anchorType}:${a.anchorId}`;

/**
 * Settlement report (design §4.5, Plane 1: Stripe payouts ↔ QB deposits),
 * reworked to the Gift report's card-first model. The page is a single list of
 * Stripe payouts missing a confirmed QB deposit (the anchors query is
 * restricted to `source=stripe_payout`, so standalone QB deposits never load):
 *   • Missing deposit — a Stripe payout with no confirmed deposit (may carry a
 *                       proposed match to approve/reject, else resolve).
 *   • Matched         — a CONFIRMED settlement link (settled). Read-only,
 *                       hidden behind the "Show matched" toggle.
 * The proposed match plus its approve/reject/resolve controls and multi-select
 * bulk actions all live on the cards. This report is Plane 1 ONLY
 * (docs/reconciliation-design.md §4.3/§4.4): Approve confirms JUST the
 * payout↔deposit settlement tie (no per-charge editor) — per-charge → gift
 * booking is owned by the Gift report. Committing stamps the deposit reconciled
 * (the double-count guard) and refreshes the sibling workbench queues.
 */
export function SettlementReport() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const selection = useRowSelection();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  // The "Matched" column (payout ↔ deposit already confirmed) is reference noise
  // for day-to-day reconciliation, so it's hidden by default and revealed via a
  // toggle — mirroring the Gift report's behavior.
  const [showMatched, setShowMatched] = usePersistedState<boolean>(
    "recon.settlement.showMatched",
    false,
  );

  const confirmM = useConfirmSettlementLink();
  const rejectM = useRejectSettlementProposal();
  const chargeTiesM = useConfirmPayoutChargeTies();

  const { data, isLoading, isError } = useListReconciliationBundleAnchors({
    queue: "all",
    source: "stripe_payout",
    limit: 10000,
  });

  const rows = useMemo(() => data?.data ?? [], [data]);

  const { matched, missingDeposit } = useMemo(() => {
    const matched: BundleAnchor[] = [];
    const missingDeposit: BundleAnchor[] = [];
    for (const a of rows) {
      // Only a CONFIRMED link is "Matched" (read-only). A `proposed` tie is
      // still actionable, so it stays in the main list with the proposal
      // shown inline on the card.
      if (a.batchStatus === "settled") {
        matched.push(a);
      } else {
        missingDeposit.push(a);
      }
    }
    return { matched, missingDeposit };
  }, [rows]);

  // Fast lookup for bulk actions over the selected keys.
  const byKey = useMemo(() => {
    const m = new Map<string, BundleAnchor>();
    for (const a of missingDeposit) m.set(anchorKey(a), a);
    return m;
  }, [missingDeposit]);

  const selectedAnchors = useMemo(
    () =>
      selection.selectedIds
        .map((k) => byKey.get(k))
        .filter((a): a is BundleAnchor => a != null),
    [selection.selectedIds, byKey],
  );

  const invalidateWorkbench = useCallback(() => {
    // Drop just-committed anchors from the list…
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

  const runBulkApprove = useCallback(async () => {
    // Both confirm endpoints are keyed by the payout, so approve the selected
    // anchors by anchorId. A deposit-lump proposal approves via the settlement
    // confirm; a payout whose charges carry proposed QB ties
    // (individually-booked money, no deposit lump) approves via the
    // charge-ties confirm.
    const targets = selectedAnchors.filter(
      (a) => a.proposedMatch || (a.chargeTiesProposed ?? 0) > 0,
    );
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
        if (a.proposedMatch) {
          await confirmM.mutateAsync({ payoutId: a.anchorId, data: {} });
        } else {
          await chargeTiesM.mutateAsync({ payoutId: a.anchorId, data: {} });
        }
        approved += 1;
        done.push(anchorKey(a));
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
          ? `${skipped} changed, ${failed} failed.`
          : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedAnchors,
    selection,
    invalidateWorkbench,
    confirmM,
    chargeTiesM,
    toast,
  ]);

  const runBulkReject = useCallback(async () => {
    const targets = selectedAnchors.filter((a) => a.proposedMatch);
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
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowMatched((s) => !s)}
          data-testid="button-settlement-toggle-matched"
          title={
            showMatched
              ? "Hide the Matched column (payout ↔ deposit already confirmed)."
              : "Show the Matched column (payout ↔ deposit already confirmed)."
          }
        >
          {showMatched ? (
            <EyeOff className="mr-1 h-3.5 w-3.5" />
          ) : (
            <Eye className="mr-1 h-3.5 w-3.5" />
          )}
          {showMatched ? "Hide matched" : "Show matched"}
        </Button>
      </div>

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
        <div
          className={`grid grid-cols-1 gap-3 ${
            showMatched ? "lg:grid-cols-2" : ""
          }`}
        >
          {showMatched && (
            <SettlementColumn
              title="Matched"
              hint="Payout ↔ deposit confirmed"
              rows={matched}
              selectable={false}
              selection={selection}
              onChanged={handleChanged}
            />
          )}
          <SettlementColumn
            title="Missing deposit"
            hint="Stripe payout, no confirmed deposit"
            rows={missingDeposit}
            selectable
            selection={selection}
            onChanged={handleChanged}
          />
        </div>
      )}

      {flagOpen && (
        <BulkFlagForResearchDialog
          targets={selectedAnchors.map((a) => ({
            targetType: "stripe_payout" as const,
            targetId: a.anchorId,
          }))}
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
