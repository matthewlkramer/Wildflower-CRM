import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCandidateThankYouEmails,
  useLinkThankYouEmail,
  useUnlinkThankYouEmail,
  getGetGiftOrPaymentQueryKey,
  type GiftOrPaymentDetail,
  type CandidateThankYouEmail,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { formatDate, decodeHtmlEntities } from "@/lib/format";
import { Paperclip, Mail, Unlink2, FileText } from "lucide-react";

type Props = { gift: GiftOrPaymentDetail };

export function ThankYouPanel({ gift }: Props) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const linked = !!gift.thankYouEmailMessageId;
  const unlinkMut = useUnlinkThankYouEmail({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getGetGiftOrPaymentQueryKey(gift.id) });
        toast({ title: "Thank-you email unlinked" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Unlink failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Thank-you acknowledgment</CardTitle>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={linked ? "outline" : "default"}
            onClick={() => setOpen(true)}
            data-testid="button-link-thank-you"
          >
            <Mail className="h-4 w-4 mr-2" />
            {linked ? "Change email" : "Link email"}
          </Button>
          {linked && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => unlinkMut.mutate({ id: gift.id })}
              disabled={unlinkMut.isPending}
              data-testid="button-unlink-thank-you"
            >
              <Unlink2 className="h-4 w-4 mr-2" />
              Unlink
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {linked ? (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-muted-foreground">Sent</span>
              <span>{formatDate(gift.thankYouSentAt)}</span>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Attachments
              </div>
              {(gift.thankYouAttachments ?? []).length === 0 ? (
                <div className="text-muted-foreground text-xs">
                  No attachments on the linked email.
                </div>
              ) : (
                <ul className="space-y-1">
                  {(gift.thankYouAttachments ?? []).map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <a
                        href={a.downloadUrl}
                        className="text-primary hover:underline truncate"
                        target="_blank"
                        rel="noreferrer"
                        data-testid={`link-thank-you-attachment-${a.id}`}
                      >
                        {a.filename ?? "attachment"}
                      </a>
                      {a.mimeType && (
                        <span className="text-xs text-muted-foreground">
                          {a.mimeType.split("/").pop()}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-xs">
            No thank-you email linked. We'll suggest one automatically when we
            see an outbound email to this funder with a document attached, or
            you can link one manually.
          </p>
        )}
      </CardContent>
      {open && (
        <LinkDialog
          giftId={gift.id}
          currentId={gift.thankYouEmailMessageId ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

function LinkDialog({
  giftId,
  currentId,
  onClose,
}: {
  giftId: string;
  currentId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useListCandidateThankYouEmails(giftId);
  const candidates = data?.data ?? [];
  const linkMut = useLinkThankYouEmail({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getGetGiftOrPaymentQueryKey(giftId) });
        toast({ title: "Thank-you email linked" });
        onClose();
      },
      onError: (err: unknown) =>
        toast({
          title: "Link failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
      onSettled: () => setPendingId(null),
    },
  });

  function link(emailMessageId: string) {
    setPendingId(emailMessageId);
    linkMut.mutate({ id: giftId, data: { emailMessageId } });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Link thank-you email</DialogTitle>
          <DialogDescription>
            Outbound emails sent from your mailbox to funder contacts within
            ±90 days of this gift. Suggested matches are highlighted.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[28rem] overflow-y-auto -mx-2 px-2">
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Loading candidates…
            </div>
          ) : isError ? (
            <div className="text-sm text-destructive py-8 text-center">
              {error instanceof Error ? error.message : "Failed to load candidates."}
            </div>
          ) : candidates.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No matching outbound emails found in the window.
            </div>
          ) : (
            <ul className="divide-y border rounded-md">
              {candidates.map((c) => (
                <CandidateRow
                  key={c.emailMessageId}
                  candidate={c}
                  isCurrent={c.emailMessageId === currentId}
                  isPending={pendingId === c.emailMessageId}
                  onLink={() => link(c.emailMessageId)}
                />
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  candidate: c,
  isCurrent,
  isPending,
  onLink,
}: {
  candidate: CandidateThankYouEmail;
  isCurrent: boolean;
  isPending: boolean;
  onLink: () => void;
}) {
  return (
    <li
      className="flex items-start gap-3 p-3"
      data-testid={`candidate-thank-you-${c.emailMessageId}`}
    >
      <FileText className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">{c.subject ? decodeHtmlEntities(c.subject) : "(no subject)"}</span>
          {c.autoSuggested && (
            <Badge variant="default" className="text-xs">Suggested</Badge>
          )}
          {c.hasDocumentAttachment && (
            <Badge variant="outline" className="text-xs">
              <Paperclip className="h-3 w-3 mr-1" />
              {c.documentAttachmentCount} doc
              {c.documentAttachmentCount === 1 ? "" : "s"}
            </Badge>
          )}
          {isCurrent && (
            <Badge variant="secondary" className="text-xs">Currently linked</Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          To: {(c.toEmails ?? []).join(", ") || "—"}
        </div>
        <div className="text-xs text-muted-foreground">
          Sent {formatDate(c.sentAt)}
        </div>
        {c.snippet && (
          <div className="text-xs text-muted-foreground line-clamp-2">{decodeHtmlEntities(c.snippet)}</div>
        )}
      </div>
      <Button
        size="sm"
        variant={isCurrent ? "outline" : "default"}
        onClick={onLink}
        disabled={isPending || isCurrent}
        data-testid={`button-link-candidate-${c.emailMessageId}`}
      >
        {isPending ? "Linking…" : isCurrent ? "Linked" : "Link"}
      </Button>
    </li>
  );
}
