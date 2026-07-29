import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCleanupQueue,
  getListCleanupQueueQueryKey,
  useUpdateCleanupItem,
  useResolveCleanupItem,
  useDismissCleanupItem,
  type CleanupItem,
  type CleanupQueueStatus,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CLEANUP_KEY_PREFIX = "/api/cleanup-queue";

const STATUS_LABEL: Record<CleanupQueueStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

const REASON_LABEL: Record<string, string> = {
  conditional_commitment_stage: "Conditional commitment",
  needs_research: "Research needed",
  issues_to_address: "Issue to address",
};

function targetHref(type: string, id: string): string {
  switch (type) {
    case "pledge":
      return `/pledges/${id}`;
    case "opportunity":
      return `/opportunities/${id}`;
    case "organization":
      return `/organizations/${id}`;
    case "person":
      return `/individuals/${id}`;
    case "gift":
      return `/gifts/${id}`;
    case "staged_payment":
    case "stripe_payout":
      return "/reconciliation/deposits";
    default:
      return `/pledges/${id}`;
  }
}

export default function CleanupQueuePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CleanupQueueStatus>("open");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");

  const params = { status, limit: 200 } as const;
  const { data, isLoading, isError } = useListCleanupQueue(params, {
    query: { queryKey: getListCleanupQueueQueryKey(params) },
  });

  const updateMut = useUpdateCleanupItem();
  const resolveMut = useResolveCleanupItem();
  const dismissMut = useDismissCleanupItem();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [CLEANUP_KEY_PREFIX] });

  const startEditing = (item: CleanupItem) => {
    setEditingId(item.id);
    setDraftNote(item.note);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraftNote("");
  };

  const handleSaveNote = (item: CleanupItem) => {
    const note = draftNote.trim();
    if (!note) {
      toast({
        title: "A note is required",
        description: "Cleanup records cannot have an empty note.",
        variant: "destructive",
      });
      return;
    }
    updateMut.mutate(
      { id: item.id, data: { note } },
      {
        onSuccess: () => {
          cancelEditing();
          void invalidate();
          toast({ title: "Cleanup note saved" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't save note",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleResolve = (item: CleanupItem) => {
    resolveMut.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({
            title: "Resolved",
            description: "This item has been cleared from the queue.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't resolve",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleDismiss = (item: CleanupItem) => {
    dismissMut.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({
            title: "Dismissed",
            description: "This item won't show in the open queue.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't dismiss",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const items = data?.data ?? [];
  const pending =
    updateMut.isPending || resolveMut.isPending || dismissMut.isPending;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Cleanup Queue
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Records flagged for manual data cleanup. Edit the shared note to
          exchange updates with other reviewers, then resolve the item — or
          dismiss it if no change is needed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={status}
          onValueChange={(v) => setStatus(v as CleanupQueueStatus)}
        >
          <SelectTrigger className="w-48" data-testid="select-cleanup-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
        {!isLoading && !isError ? (
          <span className="ml-auto text-sm text-muted-foreground">
            {items.length.toLocaleString()}{" "}
            {items.length === 1 ? "item" : "items"}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Loading cleanup queue…
        </p>
      ) : isError ? (
        <p className="text-sm text-destructive py-8 text-center">
          Failed to load the cleanup queue.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {status === "open"
            ? "Nothing to clean up. 🎉"
            : `No ${STATUS_LABEL[status].toLowerCase()} items.`}
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const editing = editingId === item.id;
            return (
              <div
                key={item.id}
                className="rounded-lg border p-4 space-y-2"
                data-testid={`cleanup-item-${item.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {REASON_LABEL[item.reasonCode] ?? item.reasonCode}
                  </Badge>
                  {item.status !== "open" ? (
                    <Badge variant="outline">{STATUS_LABEL[item.status]}</Badge>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    Flagged {formatDateShort(item.flaggedAt)} by{" "}
                    {item.flaggedByUserName ?? "System"}
                  </span>
                </div>

                <Link
                  href={targetHref(item.targetType, item.targetId)}
                  className="font-medium text-primary underline-offset-2 hover:underline break-words"
                  data-testid={`link-cleanup-target-${item.id}`}
                >
                  {item.targetName ?? `${item.targetType} ${item.targetId}`}
                </Link>

                {editing ? (
                  <div className="space-y-2">
                    <Textarea
                      value={draftNote}
                      onChange={(event) => setDraftNote(event.target.value)}
                      rows={5}
                      disabled={updateMut.isPending}
                      data-testid={`textarea-cleanup-note-${item.id}`}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={updateMut.isPending}
                        onClick={cancelEditing}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={updateMut.isPending || !draftNote.trim()}
                        onClick={() => handleSaveNote(item)}
                        data-testid={`button-save-note-${item.id}`}
                      >
                        Save note
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {item.note}
                  </p>
                )}

                {!editing ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => startEditing(item)}
                      data-testid={`button-edit-note-${item.id}`}
                    >
                      Edit note
                    </Button>
                    {item.status === "open" ? (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => handleDismiss(item)}
                          data-testid={`button-dismiss-${item.id}`}
                        >
                          Dismiss
                        </Button>
                        <Button
                          size="sm"
                          disabled={pending}
                          onClick={() => handleResolve(item)}
                          data-testid={`button-resolve-${item.id}`}
                        >
                          Resolve
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {STATUS_LABEL[item.status]}
                        {item.resolvedByUserName
                          ? ` by ${item.resolvedByUserName}`
                          : ""}
                        {item.resolvedAt
                          ? ` on ${formatDateShort(item.resolvedAt)}`
                          : ""}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
