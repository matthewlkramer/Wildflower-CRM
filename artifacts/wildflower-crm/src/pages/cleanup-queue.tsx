import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCleanupQueue,
  getListCleanupQueueQueryKey,
  useUpdateCleanupItem,
  useResolveCleanupItem,
  useDismissCleanupItem,
  useApplyCleanupProposal,
  useApplyHighConfidenceCleanupProposals,
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
  donor_attribution_review: "Donor attribution",
  donor_attribution_auto_normalized: "Donor normalized",
  donor_intermediary_review: "Default intermediary",
  primary_household_review: "Primary household",
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
    case "household":
      return `/households/${id}`;
    case "gift":
      return `/gifts/${id}`;
    case "staged_payment":
    case "stripe_payout":
      return "/reconciliation/deposits";
    default:
      return `/pledges/${id}`;
  }
}

function proposalSummary(item: CleanupItem): string | null {
  const proposal = item.proposedChanges;
  if (!proposal) return null;
  if (item.proposalKind === "gift_donor" && proposal.toDonor) {
    return `Change donor to ${proposal.toDonor.name ?? `${proposal.toDonor.kind} ${proposal.toDonor.id}`}`;
  }
  if (
    item.proposalKind === "default_intermediary" &&
    proposal.paymentIntermediary
  ) {
    return `Set ${proposal.paymentIntermediary.name ?? proposal.paymentIntermediary.id} as default intermediary`;
  }
  return proposal.rationale ?? null;
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
  const applyMut = useApplyCleanupProposal();
  const bulkApplyMut = useApplyHighConfidenceCleanupProposals();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [CLEANUP_KEY_PREFIX] });
  const pending =
    updateMut.isPending ||
    resolveMut.isPending ||
    dismissMut.isPending ||
    applyMut.isPending ||
    bulkApplyMut.isPending;

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
      toast({ title: "A note is required", variant: "destructive" });
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

  const handleApply = (item: CleanupItem) => {
    applyMut.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({ title: "Proposal applied" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't apply proposal",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleBulkApply = () => {
    bulkApplyMut.mutate(undefined, {
      onSuccess: (result) => {
        void invalidate();
        toast({
          title: `${result.applied} high-confidence proposal${result.applied === 1 ? "" : "s"} applied`,
          description: result.skipped
            ? `${result.skipped} skipped because the underlying record changed.`
            : undefined,
        });
      },
      onError: (err) =>
        toast({
          title: "Couldn't apply proposals",
          description:
            err instanceof Error ? err.message : "Something went wrong.",
          variant: "destructive",
        }),
    });
  };

  const transition = (item: CleanupItem, action: "resolve" | "dismiss") => {
    const mutation = action === "resolve" ? resolveMut : dismissMut;
    mutation.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({ title: action === "resolve" ? "Resolved" : "Dismissed" });
        },
        onError: (err) =>
          toast({
            title: `Couldn't ${action}`,
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const items = data?.data ?? [];
  const highConfidenceCount = items.filter(
    (item) =>
      item.status === "open" &&
      item.proposalConfidence === "high" &&
      item.proposalKind,
  ).length;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Cleanup Queue
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review data-cleanup items and structured donor-attribution proposals.
          Applying an attribution proposal changes CRM donor fields or an
          intermediary default; it never edits accounting evidence.
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
        {status === "open" && highConfidenceCount > 0 ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={handleBulkApply}
            data-testid="button-apply-high-confidence"
          >
            Apply {highConfidenceCount} high-confidence proposal
            {highConfidenceCount === 1 ? "" : "s"}
          </Button>
        ) : null}
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
            ? "Nothing to clean up."
            : `No ${STATUS_LABEL[status].toLowerCase()} items.`}
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const editing = editingId === item.id;
            const summary = proposalSummary(item);
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
                  {item.proposalConfidence ? (
                    <Badge
                      variant={
                        item.proposalConfidence === "high"
                          ? "default"
                          : "outline"
                      }
                    >
                      {item.proposalConfidence} confidence
                    </Badge>
                  ) : null}
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
                  className="font-medium text-primary hover:underline break-words"
                >
                  {item.targetName ?? `${item.targetType} ${item.targetId}`}
                </Link>

                {summary ? (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <div className="font-medium">Proposed change</div>
                    <div>{summary}</div>
                    {item.proposedChanges?.rationale ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.proposedChanges.rationale}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {editing ? (
                  <div className="space-y-2">
                    <Textarea
                      value={draftNote}
                      onChange={(event) => setDraftNote(event.target.value)}
                      rows={5}
                      disabled={updateMut.isPending}
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={cancelEditing}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={!draftNote.trim()}
                        onClick={() => handleSaveNote(item)}
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
                    >
                      Edit note
                    </Button>
                    {item.status === "open" ? (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => transition(item, "dismiss")}
                        >
                          Dismiss
                        </Button>
                        {item.proposalKind && item.proposedChanges ? (
                          <Button
                            size="sm"
                            disabled={pending}
                            onClick={() => handleApply(item)}
                            data-testid={`button-apply-proposal-${item.id}`}
                          >
                            Apply proposal
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={pending}
                            onClick={() => transition(item, "resolve")}
                          >
                            Resolve
                          </Button>
                        )}
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
