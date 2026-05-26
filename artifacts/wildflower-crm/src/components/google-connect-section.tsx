import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetGoogleOauthStatus,
  useDisconnectGoogleOauth,
  getGetGoogleOauthStatusQueryKey,
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

// Per-user OAuth grant for Gmail + Calendar sync. The token row lives in
// `google_oauth_tokens`; the sync workers consume it. Each staff member
// connects their own mailbox — this is a user setting, not admin config,
// so it lives on the Settings page (and was moved out of /admin).
export default function GoogleConnectSection({
  returnTo = "/settings",
}: {
  returnTo?: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const statusQ = useGetGoogleOauthStatus({
    query: {
      queryKey: getGetGoogleOauthStatusQueryKey(),
      refetchOnWindowFocus: true,
    },
  });
  const disconnect = useDisconnectGoogleOauth({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetGoogleOauthStatusQueryKey() });
        toast({
          title: "Disconnected",
          description: "Your Google account has been unlinked.",
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

  // Surface ?google_oauth=connected|denied from the callback redirect.
  // Runs once on mount; we strip the query param so a refresh doesn't
  // replay the toast.
  useMemo(() => {
    if (typeof window === "undefined") return null;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("google_oauth");
    if (!result) return null;
    if (result === "connected") {
      toast({
        title: "Google connected",
        description: "Gmail & Calendar sync will start on the next cycle.",
      });
    } else if (result === "denied") {
      toast({
        title: "Connection cancelled",
        description: "Google sign-in was cancelled.",
        variant: "destructive",
      });
    }
    url.searchParams.delete("google_oauth");
    window.history.replaceState({}, "", url.toString());
    return null;
  }, [toast]);

  const status = statusQ.data;
  const handleConnect = () => {
    // Browser navigation — the start route 302s to Google. We can't do
    // this via fetch because Google's consent screen has to be the
    // top-level navigation.
    window.location.href = `/api/google-oauth/start?returnTo=${encodeURIComponent(
      returnTo,
    )}`;
  };

  return (
    <Card data-testid="google-connect-section">
      <CardHeader>
        <CardTitle>Connect Gmail &amp; Calendar</CardTitle>
        <CardDescription>
          Link your Google account so your emails and meetings with people in
          the CRM automatically show up on their detail pages. Each staff
          member connects their own mailbox; you can disconnect any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {statusQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : status?.configured === false ? (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900">
            Google OAuth isn't configured on the server yet. An admin needs
            to set <code className="font-mono">GOOGLE_OAUTH_CLIENT_ID</code>{" "}
            and{" "}
            <code className="font-mono">GOOGLE_OAUTH_CLIENT_SECRET</code> in
            Secrets, then this section will let you connect.
          </div>
        ) : status?.connected ? (
          <div className="space-y-3">
            <div className="text-sm">
              <div>
                <span className="text-muted-foreground">Connected as: </span>
                <span className="font-medium">{status.googleEmail ?? "—"}</span>
              </div>
              {status.grantedAt ? (
                <div className="text-muted-foreground mt-1">
                  Authorized {new Date(status.grantedAt).toLocaleString()}
                </div>
              ) : null}
              {status.lastError ? (
                <div className="text-red-700 mt-1">
                  Last sync error: {status.lastError}
                </div>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
                data-testid="google-disconnect"
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
              <Button
                variant="ghost"
                onClick={handleConnect}
                data-testid="google-reconnect"
              >
                Reconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {status?.revokedAt ? (
              <p className="text-sm text-muted-foreground">
                Disconnected on {new Date(status.revokedAt).toLocaleString()}.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Not connected.</p>
            )}
            <Button onClick={handleConnect} data-testid="google-connect">
              Connect Google account
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
