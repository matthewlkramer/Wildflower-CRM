import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetQuickbooksOauthStatus,
  useDisconnectQuickbooksOauth,
  useRunQuickbooksSync,
  useResyncQuickbooksFull,
  useGetQuickbooksResyncStatus,
  getGetQuickbooksOauthStatusQueryKey,
  getGetQuickbooksResyncStatusQueryKey,
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

// Org-wide QuickBooks Online connection (admin-only). One admin connects a
// single QuickBooks company; the whole CRM pulls incoming-money records from
// it into the review queue. The grant lives in `quickbooks_connections`.
export default function QuickbooksConnectSection({
  returnTo = "/settings",
}: {
  returnTo?: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const statusQ = useGetQuickbooksOauthStatus({
    query: {
      queryKey: getGetQuickbooksOauthStatusQueryKey(),
      refetchOnWindowFocus: true,
    },
  });
  const disconnect = useDisconnectQuickbooksOauth({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getGetQuickbooksOauthStatusQueryKey(),
        });
        toast({
          title: "Disconnected",
          description: "QuickBooks has been unlinked.",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Disconnect failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });
  const syncNow = useRunQuickbooksSync({
    mutation: {
      onSuccess: (data) => {
        qc.invalidateQueries({
          queryKey: getGetQuickbooksOauthStatusQueryKey(),
        });
        toast({
          title: "Sync complete",
          description: data.ran
            ? `Pulled ${data.pulled}, staged ${data.staged} new (${data.matched} auto-matched).`
            : "A sync was already in progress.",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Sync failed",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  // Background, non-destructive full re-pull: re-fetches and re-enriches every
  // historical staged row (preserving review state) so capture-field
  // improvements — e.g. income accounts on older invoiced service payments
  // whose Product/Service item was later deleted in QuickBooks — backfill onto
  // existing rows. The incremental "Sync now" only pulls since the watermark
  // and never re-touches old transactions, so this is the only way to backfill.
  const resyncStatusQ = useGetQuickbooksResyncStatus({
    query: {
      queryKey: getGetQuickbooksResyncStatusQueryKey(),
      enabled: statusQ.data?.connected === true,
      refetchInterval: (query) =>
        query.state.data?.status === "running" ? 4000 : false,
    },
  });
  const resyncFull = useResyncQuickbooksFull({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getGetQuickbooksResyncStatusQueryKey(),
        });
        toast({
          title: "Full re-pull started",
          description:
            "Re-enriching all QuickBooks records in the background. This can take a few minutes.",
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

  // Surface ?quickbooks_oauth=connected|denied from the callback redirect.
  useMemo(() => {
    if (typeof window === "undefined") return null;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("quickbooks_oauth");
    if (!result) return null;
    if (result === "connected") {
      toast({
        title: "QuickBooks connected",
        description: "Payment sync will start on the next cycle.",
      });
    } else if (result === "denied") {
      toast({
        title: "Connection cancelled",
        description: "QuickBooks authorization was cancelled.",
        variant: "destructive",
      });
    }
    url.searchParams.delete("quickbooks_oauth");
    window.history.replaceState({}, "", url.toString());
    return null;
  }, [toast]);

  const status = statusQ.data;
  const resync = resyncStatusQ.data;
  const resyncRunning = resync?.status === "running" || resyncFull.isPending;
  const handleConnect = () => {
    // Browser navigation — the start route 302s to Intuit's consent screen,
    // which must be a top-level navigation (not a fetch).
    window.location.href = `/api/quickbooks-oauth/start?returnTo=${encodeURIComponent(
      returnTo,
    )}`;
  };

  return (
    <Card data-testid="quickbooks-connect-section">
      <CardHeader>
        <CardTitle>Connect QuickBooks Online</CardTitle>
        <CardDescription>
          Link your organization's QuickBooks company so incoming payments
          (sales receipts, payments, and deposits) are pulled into the CRM
          and staged for review. This is an organization-wide connection set
          up once by an admin. Pull-only — the CRM never writes back to
          QuickBooks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {statusQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : status?.configured === false ? (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
            QuickBooks OAuth isn't configured on the server yet. An admin
            needs to set{" "}
            <code className="font-mono">QUICKBOOKS_CLIENT_ID</code> and{" "}
            <code className="font-mono">QUICKBOOKS_CLIENT_SECRET</code> in
            Secrets, then this section will let you connect.
          </div>
        ) : status?.connected ? (
          <div className="space-y-3">
            <div className="text-sm">
              <div>
                <span className="text-muted-foreground">Company: </span>
                <span className="font-medium">
                  {status.companyName ?? status.realmId ?? "—"}
                </span>
              </div>
              {status.grantedAt ? (
                <div className="text-muted-foreground mt-1">
                  Authorized {new Date(status.grantedAt).toLocaleString()}
                </div>
              ) : null}
              {status.lastSyncedAt ? (
                <div className="text-muted-foreground mt-1">
                  Last synced{" "}
                  {new Date(status.lastSyncedAt).toLocaleString()}
                </div>
              ) : null}
              {status.lastError ? (
                <div className="text-red-700 mt-1">
                  Last sync error: {status.lastError}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => syncNow.mutate()}
                disabled={syncNow.isPending}
                data-testid="quickbooks-sync-now"
              >
                {syncNow.isPending ? "Syncing…" : "Sync now"}
              </Button>
              <Button
                variant="outline"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
                data-testid="quickbooks-disconnect"
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
              <Button
                variant="ghost"
                onClick={handleConnect}
                data-testid="quickbooks-reconnect"
              >
                Reconnect
              </Button>
              <Button
                variant="outline"
                onClick={() => resyncFull.mutate()}
                disabled={resyncRunning}
                data-testid="quickbooks-resync-full"
                title="Re-pull and re-enrich every historical QuickBooks record (e.g. income accounts on older invoiced service payments whose item was later deleted). Runs in the background; non-destructive and preserves review state."
              >
                {resyncRunning ? "Re-pulling all…" : "Full re-pull"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              "Sync now" only pulls payments since the last sync. Use "Full
              re-pull" to re-enrich older records (for example, income accounts
              on past invoiced service payments) — it runs in the background and
              keeps all review state.
            </p>
            {resync && resync.status !== "idle" ? (
              <div className="text-sm" data-testid="quickbooks-resync-status">
                {resync.status === "running" ? (
                  <span className="text-muted-foreground">
                    Re-pulling all records…
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
                      ? ` — pulled ${resync.summary.pulled}, staged ${resync.summary.staged} new.`
                      : "."}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            {status?.revokedAt ? (
              <p className="text-sm text-muted-foreground">
                Disconnected on{" "}
                {new Date(status.revokedAt).toLocaleString()}.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Not connected.</p>
            )}
            <Button onClick={handleConnect} data-testid="quickbooks-connect">
              Connect QuickBooks
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
