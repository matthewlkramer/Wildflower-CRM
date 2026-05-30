import { useState } from "react";
import {
  useGetEmailMessage,
  useUpdateEmailMessagePrivacy,
  getGetEmailMessageQueryKey,
  getListEmailMessagesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Lock, Paperclip, ExternalLink } from "lucide-react";
import { decodeHtmlEntities } from "@/lib/format";

interface Props {
  emailId: string | null;
  onClose: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmailDetailDialog({ emailId, onClose }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useGetEmailMessage(emailId ?? "", {
    query: {
      queryKey: getGetEmailMessageQueryKey(emailId ?? ""),
      enabled: !!emailId,
    },
  });
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  // Privacy is owner-only; the API returns 404 to non-owners. We surface
  // that as an inline error rather than trying to hide the toggle —
  // there's no /users/me hook plumbed through the generated client yet.
  const togglePrivacy = useUpdateEmailMessagePrivacy({
    mutation: {
      onSuccess: () => {
        setPrivacyError(null);
        if (emailId) {
          qc.invalidateQueries({ queryKey: getGetEmailMessageQueryKey(emailId) });
        }
        qc.invalidateQueries({ queryKey: getListEmailMessagesQueryKey() });
      },
      onError: () => {
        setPrivacyError(
          "Only the mailbox owner can change this email's privacy.",
        );
      },
    },
  });

  const open = !!emailId;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {data?.isPrivate ? <Lock className="h-4 w-4" /> : null}
            <span>
              {data?.subject ? decodeHtmlEntities(data.subject) : "(no subject)"}
            </span>
          </DialogTitle>
        </DialogHeader>
        {isLoading || !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="text-sm space-y-1 border-b pb-3">
              <div>
                <span className="text-muted-foreground">From: </span>
                {data.fromEmail ?? "(unknown)"}
              </div>
              {data.toEmails?.length ? (
                <div>
                  <span className="text-muted-foreground">To: </span>
                  {data.toEmails.join(", ")}
                </div>
              ) : null}
              {data.ccEmails?.length ? (
                <div>
                  <span className="text-muted-foreground">Cc: </span>
                  {data.ccEmails.join(", ")}
                </div>
              ) : null}
              <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                <Badge variant="outline">{data.direction}</Badge>
                <span>{new Date(data.sentAt).toLocaleString()}</span>
                <a
                  className="ml-auto inline-flex items-center gap-1 hover:underline"
                  href={`https://mail.google.com/mail/u/0/#all/${data.gmailMessageId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Gmail <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-md border p-3">
              <Switch
                id="email-private"
                checked={data.isPrivate}
                onCheckedChange={(v) =>
                  togglePrivacy.mutate({ id: data.id, data: { isPrivate: v } })
                }
                disabled={togglePrivacy.isPending}
                data-testid="switch-email-private"
              />
              <Label htmlFor="email-private" className="text-sm">
                Private — only I can see this email
              </Label>
            </div>
            {privacyError ? (
              <p className="text-sm text-destructive">{privacyError}</p>
            ) : null}

            {data.attachments?.length ? (
              <div className="space-y-2">
                <div className="text-sm font-medium flex items-center gap-1">
                  <Paperclip className="h-4 w-4" /> Attachments
                </div>
                <ul className="space-y-1">
                  {data.attachments.map((a) => (
                    <li key={a.id} className="text-sm">
                      <a
                        href={`/api/email-attachments/${a.id}/download`}
                        className="hover:underline"
                        data-testid={`attachment-${a.id}`}
                      >
                        {a.filename}
                      </a>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {a.mimeType} · {fmtBytes(a.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {data.aiSummary ? (
              <div
                className="rounded-md border bg-muted/30 p-3 text-sm"
                data-testid="email-ai-summary"
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                  Summary (sender opted out of storing body)
                </div>
                <div>{decodeHtmlEntities(data.aiSummary)}</div>
              </div>
            ) : null}

            <div className="text-sm">
              {data.bodyHtml ? (
                // Rendered in a sandboxed iframe srcdoc so any HTML/CSS in
                // the email body can't reach our app's DOM, fire JS, or
                // call out to the network. Two layers:
                //   1. sandbox="" disables scripts + plugins + form
                //      submission + same-origin access.
                //   2. A strict CSP meta tag injected at the top of the
                //      srcDoc blocks ALL outbound network (img, css,
                //      font, fetch) so remote tracking pixels in
                //      marketing email can't phone home from a CRM
                //      preview. Inline styles are still allowed so the
                //      email layout doesn't collapse.
                //   3. <script> is stripped pre-flight as defense in
                //      depth in case a future browser regresses the
                //      sandbox behavior.
                <iframe
                  title="email-body"
                  sandbox=""
                  className="w-full min-h-[400px] border rounded"
                  srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"></head><body>${data.bodyHtml.replace(
                    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
                    "",
                  )}</body></html>`}
                />
              ) : data.bodyText ? (
                <pre className="whitespace-pre-wrap font-sans text-sm">
                  {decodeHtmlEntities(data.bodyText)}
                </pre>
              ) : data.aiSummary ? null : (
                <p className="text-muted-foreground">(no body)</p>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
