import { useQueryClient } from "@tanstack/react-query";
import {
  useRunStripeSync,
  useResyncStripeFull,
  useGetStripeResyncStatus,
  useProposeHistoricalStripeReconciliation,
  getGetStripeResyncStatusQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

// Org-wide Stripe payment sync controls (admin-only). Stripe is a pull-only
// second money source parallel to QuickBooks; unlike QuickBooks there is no
// per-user OAuth connect — the server holds the account credentials — so this is
// purely action buttons:
//   • "Sync now"        — incremental pull since the watermark.
//   • "Full re-pull"    — background backfill of the ENTIRE payout
//                         back-catalogue (the first-ever sync seeds the
//                         watermark to "now", so historical payouts — e.g.
//                         2019–2021 — were never pulled). Polls for progress.
//   • "Propose historical matches" — re-runs Stripe→QuickBooks payout-match
//                         proposals across all payouts (incl. the freshly
//                         backfilled ones). Proposals only — a human confirms.
export default function StripeSyncSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const syncNow = useRunStripeSync({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Stripe sync complete",
          description: data.ran
            ? `Saw ${data.payouts} payouts, staged ${data.staged} new charges (${data.matched} matched, ${data.autoApplied} auto-applied).`
            : "Stripe sync was skipped (already running, or no Stripe connection).",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Stripe sync failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const resyncStatusQ = useGetStripeResyncStatus({
    query: {
      queryKey: getGetStripeResyncStatusQueryKey(),
      refetchInterval: (query) =>
        query.state.data?.status === "running" ? 4000 : false,
    },
  });
  const resyncFull = useResyncStripeFull({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getGetStripeResyncStatusQueryKey(),
        });
        toast({
          title: "Full re-pull started",
          description:
            "Backfilling the entire Stripe payout history in the background. This can take a few minutes.",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Could not start re-pull",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const proposeHistorical = useProposeHistoricalStripeReconciliation({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Historical matches proposed",
          description: data.ran
            ? `Scanned ${data.payoutsScanned} payouts: ${data.proposalsCreated} new proposals, ${data.conflictsFound} conflicts, ${data.unmatched} unmatched.`
            : "Pass skipped (already running, or no Stripe connection).",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Proposal pass failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const resync = resyncStatusQ.data;
  const resyncRunning = resync?.status === "running" || resyncFull.isPending;

  return (
    <Card data-testid="stripe-sync-section">
      <CardHeader>
        <CardTitle>Stripe payment sync</CardTitle>
        <CardDescription>
          Pull incoming Stripe payouts and the charges behind them into the CRM
          for reconciliation against QuickBooks. Pull-only — the CRM never writes
          back to Stripe. This is an organization-wide connection managed by an
          admin.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => syncNow.mutate()}
            disabled={syncNow.isPending}
            data-testid="stripe-sync-now"
          >
            {syncNow.isPending ? "Syncing…" : "Sync now"}
          </Button>
          <Button
            variant="outline"
            onClick={() => resyncFull.mutate()}
            disabled={resyncRunning}
            data-testid="stripe-resync-full"
            title="Backfill the entire Stripe payout history (e.g. 2019–2021 payouts the ongoing sync never pulled). Runs in the background; non-destructive and preserves review state."
          >
            {resyncRunning ? "Re-pulling all…" : "Full re-pull"}
          </Button>
          <Button
            variant="outline"
            onClick={() => proposeHistorical.mutate()}
            disabled={proposeHistorical.isPending || resyncRunning}
            data-testid="stripe-propose-historical"
            title="Re-run Stripe→QuickBooks payout-match proposals across all payouts (including the freshly backfilled ones). Proposals only — a human confirms each."
          >
            {proposeHistorical.isPending
              ? "Proposing…"
              : "Propose historical matches"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          "Sync now" only pulls payouts since the last sync. Use "Full re-pull"
          to backfill older payouts that predate the sync (it runs in the
          background and keeps all review state), then "Propose historical
          matches" to tie them to their QuickBooks deposits for review.
        </p>
        {resync && resync.status !== "idle" ? (
          <div className="text-sm" data-testid="stripe-resync-status">
            {resync.status === "running" ? (
              <span className="text-muted-foreground">
                Backfilling all payouts…
                {resync.startedAt
                  ? ` (started ${new Date(
                      resync.startedAt,
                    ).toLocaleTimeString()})`
                  : null}
              </span>
            ) : resync.status === "error" ? (
              <span className="text-red-700">
                Full re-pull failed: {resync.error ?? "Unknown error"}
              </span>
            ) : resync.status === "done" ? (
              <span className="text-muted-foreground">
                Last full re-pull
                {resync.finishedAt
                  ? ` ${new Date(resync.finishedAt).toLocaleString()}`
                  : null}
                {resync.summary
                  ? ` — saw ${resync.summary.payouts} payouts, staged ${resync.summary.staged} new charges.`
                  : null}
              </span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
