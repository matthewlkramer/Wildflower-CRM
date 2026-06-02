import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetExtensionToken,
  useRotateExtensionToken,
  getGetExtensionTokenQueryKey,
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

// Per-user token for the email-tracking browser extension. The extension runs
// on mail.google.com with no Clerk session, so the user pastes this token into
// the extension popup; the server resolves token -> user to send per-recipient
// tracked copies through that user's own Gmail. Rotating invalidates the old
// token (the extension must be re-pasted).
export default function ExtensionTokenSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState(false);

  const tokenQ = useGetExtensionToken({
    query: { queryKey: getGetExtensionTokenQueryKey() },
  });
  const rotate = useRotateExtensionToken({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetExtensionTokenQueryKey() });
        setRevealed(true);
        toast({
          title: "Token generated",
          description:
            "Copy it into the tracking extension. The previous token (if any) no longer works.",
        });
      },
      onError: (e: unknown) => {
        toast({
          title: "Could not generate token",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  const token = tokenQ.data?.token ?? null;
  const masked = token ? `${token.slice(0, 8)}${"•".repeat(16)}` : null;

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast({ title: "Copied", description: "Token copied to clipboard." });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the token and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <Card data-testid="extension-token-section">
      <CardHeader>
        <CardTitle>Email tracking extension</CardTitle>
        <CardDescription>
          Generate a personal token and paste it into the Wildflower tracking
          extension. The token lets the extension send group emails as
          individualized per-recipient copies through your own Gmail, so you can
          see exactly who opened — each recipient still sees the full To/Cc
          group. Keep this token private; treat it like a password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="mb-2 text-sm font-medium">
            How to set up the extension
          </p>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Generate your token below (or use the existing one) and click{" "}
              <span className="font-medium text-foreground">Copy</span>.
            </li>
            <li>
              In Chrome, open{" "}
              <span className="font-medium text-foreground">Gmail</span> and click
              the{" "}
              <span className="font-medium text-foreground">
                Wildflower Foundation CRM
              </span>{" "}
              extension icon in the toolbar (click the puzzle-piece icon and pin
              it if you don't see it).
            </li>
            <li>
              Paste the token into the{" "}
              <span className="font-medium text-foreground">token field</span> in
              the extension popup and save.
            </li>
            <li>
              That's it — group emails you send from Gmail now track opens per
              recipient. You only need to do this once per computer.
            </li>
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            First time using tracking? You'll also be asked to reconnect your
            Google account the first time you send, to allow sending the
            individualized copies.
          </p>
        </div>
        {tokenQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : token ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code
                className="flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm"
                data-testid="extension-token-value"
              >
                {revealed ? token : masked}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevealed((v) => !v)}
                data-testid="extension-token-reveal"
              >
                {revealed ? "Hide" : "Reveal"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={copy}
                data-testid="extension-token-copy"
              >
                Copy
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => rotate.mutate()}
                disabled={rotate.isPending}
                data-testid="extension-token-rotate"
              >
                {rotate.isPending ? "Generating…" : "Regenerate token"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Regenerating immediately invalidates the old token — you'll need
              to paste the new one into the extension.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              No token yet. Generate one, then paste it into the extension
              popup.
            </p>
            <Button
              onClick={() => rotate.mutate()}
              disabled={rotate.isPending}
              data-testid="extension-token-generate"
            >
              {rotate.isPending ? "Generating…" : "Generate token"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
