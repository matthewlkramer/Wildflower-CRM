import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStripePayoutReconciliations,
  useConfirmStripePayoutExclude,
  useConfirmStripePayoutKeep,
  useConfirmStripePayoutReplace,
  useRevertStripePayoutReconciliation,
  type StripePayoutReconciliation,
  type StripePayoutReconciliationQueue,
  type StripePayoutReconciliationStatus,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/format";

/* ────────────────────────────────────────────────────────────────────────
 * Stripe ↔ QuickBooks payout reconciliation (propose-then-confirm).
 *
 * The Stripe sync proposes, for each payout, the single QuickBooks deposit
 * lump that settled it. Nothing is auto-applied: a human confirms here. On
 * confirm the QB deposit is EXCLUDED (reason processor_payout) but kept and
 * linked — never deleted — which unblocks minting the per-charge Stripe gifts
 * (the donor-attributed source of truth) without double-counting the lump.
 *
 * When the matching QB deposit was already approved into a coarse gift, the
 * payout lands in a conflict that needs an explicit KEEP (trust the existing
 * QB gift) or REPLACE (archive the coarse gift — kept, allocations preserved,
 * revertible — and fall back to the per-charge Stripe gifts). REPLACE is the
 * default-off, destructive choice.
 * ──────────────────────────────────────────────────────────────────────── */

const QUEUES: { value: StripePayoutReconciliationQueue; label: string }[] = [
  { value: "proposed", label: "Proposals" },
  { value: "conflict", label: "Conflicts" },
  { value: "confirmed", label: "Confirmed" },
  { value: "all", label: "All" },
];

const STATUS_BADGE: Record<
  StripePayoutReconciliationStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  unmatched: { label: "Unmatched", variant: "outline" },
  proposed: { label: "Proposed — awaiting confirm", variant: "secondary" },
  conflict_approved: { label: "Conflict — needs decision", variant: "destructive" },
  confirmed_reconciled: { label: "Reconciled", variant: "default" },
  confirmed_excluded: { label: "Excluded (processor payout)", variant: "default" },
  confirmed_keep: { label: "Kept approved gift", variant: "default" },
  confirmed_replace: { label: "Replaced — old gift archived", variant: "default" },
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="text-sm tabular-nums">{value}</div>
    </div>
  );
}

export default function StripeReconciliation() {
  const [queue, setQueue] = useState<StripePayoutReconciliationQueue>("proposed");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Track in-flight rows by id so concurrent actions on different payouts each
  // disable only their own row — a single mutation hook's `variables` would be
  // overwritten by a second click and wrongly re-enable the first row.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const { data, isLoading, isError } = useListStripePayoutReconciliations({
    queue,
    limit: 100,
  });

  function refresh() {
    // Prefix-match every queue's cached list (Orval keys are "/api"-prefixed).
    void queryClient.invalidateQueries({
      queryKey: ["/api/stripe-payouts/reconciliation"],
    });
    // A confirm-replace archives a gift, so the gifts list/aggregates change.
    void queryClient.invalidateQueries({
      queryKey: ["/api/gifts-and-payments"],
    });
  }

  function onError(err: unknown) {
    toast({
      variant: "destructive",
      title: "Couldn't apply that decision",
      description:
        err instanceof Error
          ? err.message
          : "It may already have changed state — refresh and try again.",
    });
  }

  const confirmExclude = useConfirmStripePayoutExclude({
    mutation: {
      onSuccess: () => {
        toast({ title: "Deposit excluded as a processor payout." });
        refresh();
      },
      onError,
    },
  });
  const confirmKeep = useConfirmStripePayoutKeep({
    mutation: {
      onSuccess: () => {
        toast({ title: "Kept the existing approved QuickBooks gift." });
        refresh();
      },
      onError,
    },
  });
  const confirmReplace = useConfirmStripePayoutReplace({
    mutation: {
      onSuccess: () => {
        toast({ title: "Archived the old gift; per-charge Stripe gifts now apply." });
        refresh();
      },
      onError,
    },
  });
  const revert = useRevertStripePayoutReconciliation({
    mutation: {
      onSuccess: () => {
        toast({ title: "Reverted to the prior proposal." });
        refresh();
      },
      onError,
    },
  });

  function track(id: string) {
    setPendingIds((p) => new Set(p).add(id));
  }
  function untrack(id: string) {
    setPendingIds((p) => {
      const next = new Set(p);
      next.delete(id);
      return next;
    });
  }

  // Plain-button actions: swallow the rejection (onError already toasted) so we
  // don't raise an unhandled rejection.
  async function run(id: string, fn: () => Promise<unknown>) {
    track(id);
    try {
      await fn();
    } catch {
      /* onError handled the toast */
    } finally {
      untrack(id);
    }
  }

  // Dialog-driven actions: re-throw so ConfirmDeleteDialog stays open on failure.
  async function runDialog(id: string, fn: () => Promise<unknown>) {
    track(id);
    try {
      return await fn();
    } finally {
      untrack(id);
    }
  }

  const rows = data?.data ?? [];
  const total = data?.pagination?.total ?? rows.length;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-2xl font-semibold">Stripe ↔ QuickBooks reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Confirm which QuickBooks deposit lump settled each Stripe payout. A
          confirmed deposit is excluded as a processor payout — kept and linked,
          never deleted — so the per-charge Stripe gifts stay the source of truth
          without double-counting.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {QUEUES.map((q) => (
          <Button
            key={q.value}
            size="sm"
            variant={queue === q.value ? "default" : "outline"}
            onClick={() => setQueue(q.value)}
            data-testid={`queue-tab-${q.value}`}
          >
            {q.label}
          </Button>
        ))}
        <div className="ml-auto self-center text-xs text-muted-foreground">
          {total} payout{total === 1 ? "" : "s"}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Couldn't load reconciliations.</p>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing in this queue.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <PayoutCard
              key={r.id}
              recon={r}
              busy={pendingIds.has(r.id)}
              onExclude={() => run(r.id, () => confirmExclude.mutateAsync({ id: r.id }))}
              onKeep={() => run(r.id, () => confirmKeep.mutateAsync({ id: r.id }))}
              onReplace={() => runDialog(r.id, () => confirmReplace.mutateAsync({ id: r.id }))}
              onRevert={() => runDialog(r.id, () => revert.mutateAsync({ id: r.id }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PayoutCard({
  recon,
  busy,
  onExclude,
  onKeep,
  onReplace,
  onRevert,
}: {
  recon: StripePayoutReconciliation;
  busy: boolean;
  onExclude: () => void;
  onKeep: () => void;
  onReplace: () => Promise<unknown>;
  onRevert: () => Promise<unknown>;
}) {
  const badge = STATUS_BADGE[recon.qbReconciliationStatus];
  const isConfirmed =
    recon.qbReconciliationStatus === "confirmed_excluded" ||
    recon.qbReconciliationStatus === "confirmed_keep" ||
    recon.qbReconciliationStatus === "confirmed_replace";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="font-mono text-sm">{recon.id}</CardTitle>
            <CardDescription>
              Arrived {formatDate(recon.arrivalDate)} ·{" "}
              {recon.chargeCount ?? 0} charge
              {recon.chargeCount === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Payout amount" value={formatCurrency(recon.amount)} />
          <Stat label="Gross charges" value={formatCurrency(recon.grossTotal)} />
          <Stat label="Processor fees" value={formatCurrency(recon.feeTotal)} />
          <Stat label="Net settled" value={formatCurrency(recon.netTotal)} />
        </div>

        {recon.depositId ? (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-xs font-medium text-muted-foreground">
              QuickBooks deposit lump
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="tabular-nums">
                {formatCurrency(recon.depositAmount)}
              </span>
              <span className="text-muted-foreground">
                {formatDate(recon.depositDateReceived)}
              </span>
              {recon.depositPayerName ? (
                <span className="text-muted-foreground">
                  {recon.depositPayerName}
                </span>
              ) : null}
              {recon.depositStatus ? (
                <Badge variant="outline" className="text-xs">
                  {recon.depositStatus}
                </Badge>
              ) : null}
            </div>
          </div>
        ) : null}

        {recon.qbConflictGiftId ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <div className="text-xs font-medium text-destructive">
              Conflicting approved gift
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Link
                href={`/gifts/${recon.qbConflictGiftId}`}
                className="font-medium underline-offset-2 hover:underline"
              >
                {recon.conflictGiftDonorName ?? recon.qbConflictGiftId}
              </Link>
              <span className="tabular-nums">
                {formatCurrency(recon.conflictGiftAmount)}
              </span>
              <span className="text-muted-foreground">
                {formatDate(recon.conflictGiftDate)}
              </span>
              {recon.conflictGiftArchivedAt ? (
                <Badge variant="outline" className="text-xs">
                  Archived {formatDate(recon.conflictGiftArchivedAt)}
                </Badge>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {recon.qbReconciliationStatus === "proposed" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={onExclude}
              data-testid={`confirm-exclude-${recon.id}`}
            >
              Confirm — exclude deposit
            </Button>
          ) : null}

          {recon.qbReconciliationStatus === "conflict_approved" ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={onKeep}
                data-testid={`confirm-keep-${recon.id}`}
              >
                Keep approved gift
              </Button>
              <ConfirmDeleteDialog
                title="Replace the approved QuickBooks gift?"
                description="Archives the coarse QuickBooks gift (kept, not deleted — allocations preserved and this is revertible) and excludes its deposit lump, so the per-charge Stripe gifts become the source of truth. Only do this if the per-charge Stripe gifts cover the same money."
                triggerLabel="Replace…"
                confirmLabel="Replace & archive old gift"
                busyLabel="Replacing…"
                destructive
                disabled={busy}
                triggerTestId={`confirm-replace-trigger-${recon.id}`}
                confirmTestId={`confirm-replace-${recon.id}`}
                onConfirm={onReplace}
              />
            </>
          ) : null}

          {isConfirmed ? (
            <ConfirmDeleteDialog
              title="Revert this reconciliation?"
              description="Returns the payout to its prior proposal state. Refused if any of the payout's Stripe charges have already been booked into a gift."
              triggerLabel="Revert"
              confirmLabel="Revert"
              busyLabel="Reverting…"
              destructive={false}
              disabled={busy}
              triggerTestId={`revert-trigger-${recon.id}`}
              confirmTestId={`revert-${recon.id}`}
              onConfirm={onRevert}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
