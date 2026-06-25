import { useMemo, useState } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEmailProposals,
  useAcceptEmailProposal,
  useRejectEmailProposal,
  useRetryEmailProposal,
  useReviseEmailProposal,
  useReopenEmailProposal,
  useListUnrecognizedCorrespondents,
  useCreateCorrespondentIgnore,
  useCreateEmail,
  getListEmailProposalsQueryKey,
  getGetEmailProposalSummaryQueryKey,
  getListUnrecognizedCorrespondentsQueryKey,
} from "@workspace/api-client-react";
import {
  EntityCombobox,
  usePersonSearch,
  usePersonName,
} from "@/components/entity-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { decodeHtmlEntities } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { EmailDetailDialog } from "@/components/email-detail-dialog";
import { Mail, Check, X, MessageSquarePlus, ExternalLink, RefreshCw, Lightbulb, ChevronDown, ChevronRight, Undo2, EyeOff } from "lucide-react";

type Kind =
  | "linkedin_job_change"
  | "auto_responder_move"
  | "bounce_invalid"
  | "bounce_soft"
  | "signature_update"
  | "thank_you_acknowledgment"
  | "wildflower_update";

const KIND_TABS: { value: Kind; label: string }[] = [
  { value: "linkedin_job_change", label: "Job changes" },
  { value: "auto_responder_move", label: "Moved (auto-reply)" },
  { value: "bounce_invalid", label: "Hard bounces" },
  { value: "bounce_soft", label: "Soft bounces" },
  { value: "signature_update", label: "Signature updates" },
  { value: "thank_you_acknowledgment", label: "Thank-you acks" },
  { value: "wildflower_update", label: "Wildflower updates" },
];

const UNRECOGNIZED_TAB = "unrecognized";
type TabValue = Kind | typeof UNRECOGNIZED_TAB;

/**
 * Email-intelligence review queue. One tab per proposal kind plus a
 * sibling tab for unrecognized correspondents (computed live, not
 * proposal-backed).
 *
 * Tab selection persists in the URL `?kind=` so dashboard chips and
 * back/forward navigation work without resetting the user to the
 * default tab.
 *
 * Acceptance / rejection use the generated mutation hooks; on success
 * we invalidate the proposal list query keys (filtered + summary) so
 * the badges and counts on the dashboard update without a manual
 * refresh.
 */
export default function EmailIntelligencePage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const kindParam = params.get("kind");
  const initialTab: TabValue =
    kindParam === UNRECOGNIZED_TAB
      ? UNRECOGNIZED_TAB
      : (KIND_TABS.find((t) => t.value === kindParam)?.value ??
          "linkedin_job_change");
  const [tab, setTab] = useState<TabValue>(initialTab);

  const setTabAndUrl = (next: TabValue) => {
    setTab(next);
    const sp = new URLSearchParams(search);
    sp.set("kind", next);
    navigate(`/email-intelligence?${sp.toString()}`, { replace: true });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Email intelligence
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review signals the sync pass pulled out of your inbox — job
          changes spotted on LinkedIn, addresses that bounced, "I've
          moved" auto-replies, and people you've been emailing who
          aren't in the CRM yet.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTabAndUrl(v as TabValue)}>
        <TabsList className="flex-wrap h-auto">
          {KIND_TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              data-testid={`tab-${t.value}`}
            >
              {t.label}
            </TabsTrigger>
          ))}
          <TabsTrigger value={UNRECOGNIZED_TAB} data-testid="tab-unrecognized">
            New correspondents
          </TabsTrigger>
        </TabsList>

        {KIND_TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className="mt-4">
            <ProposalList kind={t.value} />
          </TabsContent>
        ))}

        <TabsContent value={UNRECOGNIZED_TAB} className="mt-4">
          <UnrecognizedCorrespondents />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProposalList({ kind }: { kind: Kind }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const params = { kind, status: "pending" as const, limit: 100 };
  const { data, isLoading, isError } = useListEmailProposals(params, {
    query: { queryKey: getListEmailProposalsQueryKey(params) },
  });

  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: getListEmailProposalsQueryKey({ kind, status: "pending" }),
    });
    void qc.invalidateQueries({
      queryKey: getGetEmailProposalSummaryQueryKey(),
    });
  };

  const accept = useAcceptEmailProposal({
    mutation: {
      onSuccess: () => {
        invalidate();
        // Accepting applies arbitrary CRM mutations (set_phone,
        // update_per_title, create_per, add_email, create_grant_opportunity,
        // …) that can touch people, roles, funders, organizations,
        // households, opportunities or gifts. Rather than enumerate every
        // affected query key, refetch all active queries so the impacted
        // record pages (e.g. the person whose phone/title just changed)
        // reflect the change immediately instead of serving stale cache.
        void qc.invalidateQueries();
        toast({ title: "Accepted" });
        closeNoteDialog();
      },
      onError: (e) =>
        toast({
          title: "Could not accept",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  // Accept/Dismiss both open a small dialog that captures an optional
  // reviewer note (free-text "why was this right/wrong?"). The note is
  // stored on the proposal row alongside the verdict so prompt-tuning
  // can later join {payload, status, reviewerNote} without an extra
  // table. Submitting with an empty note is allowed — the note is
  // purely opt-in.
  const [noteTarget, setNoteTarget] = useState<{
    id: string;
    summary: string;
    mode: "accept" | "reject";
    selection?: number[];
  } | null>(null);
  const [reviewerNote, setReviewerNote] = useState("");
  const [viewEmailId, setViewEmailId] = useState<string | null>(null);
  // Per-proposal checkbox state: which action indexes are still checked.
  // Absent entry means "all checked" (the default). Unchecking an action
  // creates an explicit Set for that proposal id.
  const [selections, setSelections] = useState<Record<string, Set<number>>>(
    {},
  );
  const proposalActions = (p: { proposedActions?: unknown }) =>
    (Array.isArray(p.proposedActions)
      ? (p.proposedActions as ProposedActionView[])
      : []);
  // A proposal is "retriable" (re-analysis can be triggered) when its AI
  // analysis failed (actionsError set) OR it never produced a result
  // (actionsAnalyzedAt null — a brand-new or operator-reopened row). Both
  // states expose a per-row Re-analyze/Retry control that routes through
  // the same owner-scoped /retry endpoint.
  const isRetriable = (p: {
    actionsError?: string | null;
    actionsAnalyzedAt?: string | null;
  }) => p.actionsError != null || p.actionsAnalyzedAt == null;
  const checkedFor = (p: { id: string; proposedActions?: unknown }) => {
    const actions = proposalActions(p);
    return selections[p.id] ?? new Set(actions.map((_, i) => i));
  };
  const toggleAction = (
    p: { id: string; proposedActions?: unknown },
    idx: number,
  ) => {
    setSelections((prev) => {
      const actions = proposalActions(p);
      const base = prev[p.id] ?? new Set(actions.map((_, i) => i));
      const next = new Set(base);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return { ...prev, [p.id]: next };
    });
  };
  // Build the accept payload selection. When the client has no actions
  // loaded yet, omit the field entirely so the server applies all
  // (backward compatible). Otherwise send the explicit checked subset —
  // an empty array means "apply nothing but still resolve".
  const selectionFor = (p: {
    id: string;
    proposedActions?: unknown;
  }): number[] | undefined => {
    const actions = proposalActions(p);
    if (actions.length === 0) return undefined;
    return [...checkedFor(p)].sort((a, b) => a - b);
  };
  const closeNoteDialog = () => {
    setNoteTarget(null);
    setReviewerNote("");
  };
  const reject = useRejectEmailProposal({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Dismissed" });
        closeNoteDialog();
      },
      onError: (e) =>
        toast({
          title: "Could not dismiss",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  // Per-proposal AI re-analysis for the "AI analysis failed" failure
  // box. We track which proposal is currently retrying so only its
  // button shows a spinner (the mutation's isPending is global). On
  // success we invalidate the list so the refreshed proposal (now with
  // real actions, or a fresh error) renders in place.
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retry = useRetryEmailProposal({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Re-analyzed" });
      },
      onError: (e) =>
        toast({
          title: "Could not re-analyze",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
      onSettled: () => setRetryingId(null),
    },
  });
  const onRetry = (id: string) => {
    setRetryingId(id);
    retry.mutate({ id });
  };

  // Bulk "Retry all": re-analyze every retriable row on the current tab.
  // Reuses the same /retry endpoint per row but through a dedicated
  // mutation instance so we emit ONE summary toast + ONE list invalidate
  // at the end instead of N. Bounded client-side concurrency keeps the
  // open-request count small; the server's AI limiter serializes the
  // actual model calls regardless.
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const bulkRetry = useRetryEmailProposal({ mutation: {} });
  const onRetryAll = async (ids: string[]) => {
    if (ids.length === 0 || bulkRetrying) return;
    setBulkRetrying(true);
    let ok = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor];
        cursor += 1;
        if (id === undefined) continue;
        try {
          await bulkRetry.mutateAsync({ id });
          ok += 1;
        } catch {
          failed += 1;
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, () => worker()),
      );
    } finally {
      invalidate();
      setBulkRetrying(false);
      toast(
        failed === 0
          ? { title: `Re-analyzed ${ok} record${ok === 1 ? "" : "s"}` }
          : {
              title: `Re-analyzed ${ok}, ${failed} failed`,
              variant: "destructive",
            },
      );
    }
  };

  // "Propose alternative": the reviewer types a plain-English correction
  // ("that's an invalid email for him — make the jfk@ one primary"); we
  // POST it to the revise endpoint, which folds the guidance into the
  // per-proposal prompt, re-runs the AI synchronously, and returns the
  // refreshed proposal. The proposal stays pending; invalidating the
  // list re-renders its suggested actions (or a fresh error) in place.
  const [proposeTarget, setProposeTarget] = useState<{
    id: string;
    summary: string;
  } | null>(null);
  const [proposeText, setProposeText] = useState("");
  const [revisingId, setRevisingId] = useState<string | null>(null);
  const closeProposeDialog = () => {
    setProposeTarget(null);
    setProposeText("");
  };
  const revise = useReviseEmailProposal({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        const reanalyzeError = res?.actionsError;
        if (reanalyzeError) {
          toast({
            title: "Re-analysis failed",
            description:
              "Your note was saved, but the AI could not refresh the suggestion. Try again shortly.",
            variant: "destructive",
          });
        } else {
          toast({ title: "Suggestion updated" });
        }
        closeProposeDialog();
      },
      onError: (e) =>
        toast({
          title: "Could not update suggestion",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
      onSettled: () => setRevisingId(null),
    },
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (isError) {
    return (
      <div className="text-sm text-destructive">
        Failed to load proposals.
      </div>
    );
  }
  const rows = data?.data ?? [];
  const retriable = rows.filter(isRetriable);
  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing pending in this category.
          </CardContent>
        </Card>
        <AutoHandledSection kind={kind} />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid={`proposal-list-${kind}`}>
      {retriable.length > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
          <div className="text-sm text-muted-foreground">
            {retriable.length} record{retriable.length === 1 ? "" : "s"} still
            awaiting analysis
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRetryAll(retriable.map((p) => p.id))}
            disabled={bulkRetrying}
            data-testid={`btn-retry-all-${kind}`}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1.5 ${bulkRetrying ? "animate-spin" : ""}`}
            />
            {bulkRetrying ? "Re-analyzing…" : `Retry all (${retriable.length})`}
          </Button>
        </div>
      ) : null}
      {rows.map((p) => (
        <Card key={p.id} data-testid={`proposal-${p.id}`}>
          <CardHeader className="pb-2 flex flex-row items-start justify-between gap-3 space-y-0">
            <div className="space-y-1 min-w-0">
              <CardTitle className="text-base font-medium truncate">
                {summarizeProposal(p)}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {new Date(p.emailSentAt ?? p.createdAt).toLocaleString()}
              </p>
              {p.reviewerNote &&
              p.reviewerNote.startsWith("Flagged inaccurate") ? (
                <p
                  className="text-xs font-medium text-amber-700"
                  data-testid={`proposal-inaccurate-${p.id}`}
                >
                  {p.reviewerNote}
                </p>
              ) : p.reviewerNote &&
                p.reviewerNote.startsWith("Auto-suppressed") ? (
                <p className="text-xs text-muted-foreground italic">
                  {p.reviewerNote}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              {p.targetPersonId ? (
                <Link
                  href={`/individuals/${p.targetPersonId}`}
                  className="text-xs text-primary hover:underline whitespace-nowrap"
                >
                  View person
                </Link>
              ) : null}
              {p.sourceMessageId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8"
                  onClick={() => setViewEmailId(p.sourceMessageId ?? null)}
                  data-testid={`btn-view-email-${p.id}`}
                >
                  <Mail className="h-3.5 w-3.5 mr-1" />
                  View email
                </Button>
              ) : (() => {
                const gmailId = (p.payload as Record<string, unknown>)?.gmailMessageId;
                return typeof gmailId === "string" && gmailId ? (
                  <a
                    href={`https://mail.google.com/mail/u/0/#all/${gmailId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground whitespace-nowrap"
                    data-testid={`btn-view-gmail-${p.id}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    View in Gmail
                  </a>
                ) : null;
              })()}
            </div>
          </CardHeader>
          <div className="px-6 pb-3 flex flex-wrap items-center gap-x-2 gap-y-2">
            {/* Positive group */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 bg-green-600 text-white hover:bg-green-700"
                disabled={accept.isPending}
                onClick={() => {
                  const sel = selectionFor(p);
                  accept.mutate({
                    id: p.id,
                    data: sel ? { selectedActionIndexes: sel } : {},
                  });
                }}
                data-testid={`btn-accept-${p.id}`}
              >
                <Check className="h-4 w-4 mr-1.5" />
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-green-700 border-green-600/40 hover:bg-green-50 hover:text-green-800"
                disabled={accept.isPending}
                onClick={() => {
                  setReviewerNote("");
                  setNoteTarget({
                    id: p.id,
                    summary: summarizeProposal(p),
                    mode: "accept",
                    selection: selectionFor(p),
                  });
                }}
                data-testid={`btn-accept-feedback-${p.id}`}
              >
                <MessageSquarePlus className="h-4 w-4 mr-1.5" />
                Accept + note
              </Button>
            </div>

            {/* Propose alternative — neutral, separated from verdict groups */}
            <div className="flex items-center gap-2">
              <div className="hidden sm:block h-6 w-px bg-border mx-1" />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={revisingId === p.id}
                onClick={() => {
                  setProposeText("");
                  setProposeTarget({ id: p.id, summary: summarizeProposal(p) });
                }}
                data-testid={`btn-propose-alt-${p.id}`}
              >
                <Lightbulb
                  className={`h-4 w-4 mr-1.5 ${
                    revisingId === p.id ? "animate-pulse" : ""
                  }`}
                />
                {revisingId === p.id ? "Re-analyzing…" : "Propose alternative"}
              </Button>
            </div>

            {/* Destructive group */}
            <div className="flex items-center gap-2 sm:ml-auto">
              <div className="hidden sm:block h-6 w-px bg-border mx-1" />
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-red-600 border-red-600/40 hover:bg-red-50 hover:text-red-700"
                disabled={reject.isPending}
                onClick={() => reject.mutate({ id: p.id, data: {} })}
                data-testid={`btn-reject-${p.id}`}
              >
                <X className="h-4 w-4 mr-1.5" />
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-red-600 border-red-600/40 hover:bg-red-50 hover:text-red-700"
                disabled={reject.isPending}
                onClick={() => {
                  setReviewerNote("");
                  setNoteTarget({
                    id: p.id,
                    summary: summarizeProposal(p),
                    mode: "reject",
                  });
                }}
                data-testid={`btn-reject-feedback-${p.id}`}
              >
                <MessageSquarePlus className="h-4 w-4 mr-1.5" />
                Dismiss + note
              </Button>
            </div>
          </div>
          <CardContent>
            <ProposalDetail kind={kind} payload={p.payload ?? {}} />
            <ProposedActionsBlock
              proposalId={p.id}
              actions={(p.proposedActions ?? []) as ProposedActionView[]}
              analyzedAt={p.actionsAnalyzedAt ?? null}
              error={p.actionsError ?? null}
              checked={checkedFor(p)}
              onToggle={(idx) => toggleAction(p, idx)}
              onRetry={() => onRetry(p.id)}
              retrying={retryingId === p.id || (bulkRetrying && isRetriable(p))}
            />
          </CardContent>
        </Card>
      ))}
      <AutoHandledSection kind={kind} />
      <Dialog
        open={noteTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeNoteDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {noteTarget?.mode === "accept"
                ? "Accept proposal"
                : "Dismiss proposal"}
            </DialogTitle>
            <DialogDescription>
              {noteTarget?.mode === "accept"
                ? "Optional — anything notable about why this one was right? Goes into prompt-tuning logs. Leave blank to accept without a note."
                : "Optional — tell us why the suggestion was wrong. This goes into prompt-tuning logs. Leave blank to dismiss without a note."}
            </DialogDescription>
          </DialogHeader>
          {noteTarget ? (
            <div className="space-y-3 min-w-0">
              <div className="text-sm font-medium truncate min-w-0">
                {noteTarget.summary}
              </div>
              <div className="space-y-1.5 min-w-0">
                <Label htmlFor="reviewer-note">Reviewer note</Label>
                <Textarea
                  id="reviewer-note"
                  value={reviewerNote}
                  onChange={(e) => setReviewerNote(e.target.value)}
                  rows={4}
                  cols={1}
                  placeholder={
                    noteTarget.mode === "accept"
                      ? "e.g. Good catch — funder name normalized correctly"
                      : "e.g. Wrong person — same name, different city"
                  }
                  data-testid="input-reviewer-note"
                  className="w-full resize-y"
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeNoteDialog}>
              Cancel
            </Button>
            <Button
              disabled={
                !noteTarget ||
                (noteTarget.mode === "accept"
                  ? accept.isPending
                  : reject.isPending)
              }
              onClick={() => {
                if (!noteTarget) return;
                const note = reviewerNote.trim();
                if (noteTarget.mode === "accept") {
                  accept.mutate({
                    id: noteTarget.id,
                    data: {
                      ...(note ? { reviewerNote: note } : {}),
                      ...(noteTarget.selection !== undefined
                        ? { selectedActionIndexes: noteTarget.selection }
                        : {}),
                    },
                  });
                } else {
                  reject.mutate({
                    id: noteTarget.id,
                    data: note ? { reviewerNote: note } : {},
                  });
                }
              }}
              data-testid={
                noteTarget?.mode === "accept"
                  ? "btn-confirm-accept"
                  : "btn-confirm-reject"
              }
            >
              {noteTarget?.mode === "accept" ? "Accept" : "Dismiss"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={proposeTarget !== null}
        onOpenChange={(open) => {
          if (!open && revisingId === null) closeProposeDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Propose alternative</DialogTitle>
            <DialogDescription>
              Tell the AI how to fix its suggestion in plain English — e.g.
              "that's an invalid email for him, mark it invalid and make the
              jfk@ one his primary." It re-runs with your guidance and updates
              the suggested actions in place. Your comment is saved with the
              other reviewer notes.
            </DialogDescription>
          </DialogHeader>
          {proposeTarget ? (
            <div className="space-y-3 min-w-0">
              <div className="text-sm font-medium truncate min-w-0">
                {proposeTarget.summary}
              </div>
              <div className="space-y-1.5 min-w-0">
                <Label htmlFor="propose-alt-text">Your instruction</Label>
                <Textarea
                  id="propose-alt-text"
                  value={proposeText}
                  onChange={(e) => setProposeText(e.target.value)}
                  rows={4}
                  cols={1}
                  placeholder="e.g. Mark jfk-old@ invalid and promote jfk@keswickpartners.com to primary"
                  data-testid="input-propose-alt"
                  className="w-full resize-y"
                  disabled={revisingId === proposeTarget.id}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeProposeDialog}
              disabled={revisingId !== null}
            >
              Cancel
            </Button>
            <Button
              disabled={
                !proposeTarget ||
                !proposeText.trim() ||
                revisingId !== null
              }
              onClick={() => {
                if (!proposeTarget) return;
                const text = proposeText.trim();
                if (!text) return;
                setRevisingId(proposeTarget.id);
                revise.mutate({
                  id: proposeTarget.id,
                  data: { reviewerGuidance: text },
                });
              }}
              data-testid="btn-confirm-propose-alt"
            >
              {revisingId !== null ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
                  Re-analyzing…
                </>
              ) : (
                "Re-analyze"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EmailDetailDialog
        emailId={viewEmailId}
        onClose={() => setViewEmailId(null)}
      />
    </div>
  );
}

/**
 * Collapsed "Auto-handled by AI" audit section for one proposal kind.
 *
 * The main queue only fetches `status: "pending"`, so proposals the
 * analysis step auto-hid — flagged inaccurate ("Flagged inaccurate: …")
 * or suppressed as noise ("Auto-suppressed: …"), both stored as
 * `status: "ignored"` — never appear there. This secondary, collapsed
 * section fetches those `ignored` rows for the current reviewer's mailbox
 * so they can spot AI mistakes (a wrong "inaccurate" verdict) and re-open
 * the proposal back into the pending queue.
 *
 * Rows are split by the distinct auto-hide reason (inaccurate vs
 * suppressed) read off the reviewer note prefix. Re-open does NOT re-run
 * the AI — it just restores the existing analysis to pending.
 */
function AutoHandledSection({ kind }: { kind: Kind }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const params = { kind, status: "ignored" as const, limit: 50 };
  const { data, isLoading } = useListEmailProposals(params, {
    query: { queryKey: getListEmailProposalsQueryKey(params) },
  });
  const [viewEmailId, setViewEmailId] = useState<string | null>(null);

  const reopen = useReopenEmailProposal({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({
          queryKey: getListEmailProposalsQueryKey({ kind, status: "ignored" }),
        });
        void qc.invalidateQueries({
          queryKey: getListEmailProposalsQueryKey({ kind, status: "pending" }),
        });
        void qc.invalidateQueries({
          queryKey: getGetEmailProposalSummaryQueryKey(),
        });
        toast({ title: "Re-opened for review" });
      },
      onError: (e) =>
        toast({
          title: "Could not re-open",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const rows = data?.data ?? [];
  const inaccurate = rows.filter((p) =>
    (p.reviewerNote ?? "").startsWith("Flagged inaccurate"),
  );
  const suppressed = rows.filter((p) =>
    (p.reviewerNote ?? "").startsWith("Auto-suppressed"),
  );
  // Any other `ignored` rows (e.g. legacy / no recognizable prefix) still
  // belong in the audit list so nothing is silently lost.
  const other = rows.filter(
    (p) => !inaccurate.includes(p) && !suppressed.includes(p),
  );

  // Nothing auto-hidden and not still loading: render nothing so the tab
  // stays clean.
  if (!isLoading && rows.length === 0) return null;

  const total = rows.length;

  const renderRow = (p: (typeof rows)[number], reason: string) => (
    <div
      key={p.id}
      className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-background px-3 py-2"
      data-testid={`auto-handled-${p.id}`}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium truncate">
          {summarizeProposal(p)}
        </div>
        <div className="text-xs text-muted-foreground">
          {new Date(p.emailSentAt ?? p.createdAt).toLocaleString()}
        </div>
        <div className="text-xs text-muted-foreground italic">{reason}</div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {p.sourceMessageId ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => setViewEmailId(p.sourceMessageId ?? null)}
            data-testid={`btn-auto-handled-view-email-${p.id}`}
          >
            <Mail className="h-3.5 w-3.5 mr-1" />
            View email
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={reopen.isPending}
          onClick={() => reopen.mutate({ id: p.id })}
          data-testid={`btn-reopen-${p.id}`}
        >
          <Undo2 className="h-4 w-4 mr-1.5" />
          Re-open
        </Button>
      </div>
    </div>
  );

  return (
    <div
      className="rounded-md border bg-muted/30"
      data-testid={`auto-handled-section-${kind}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground"
        data-testid={`btn-toggle-auto-handled-${kind}`}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
        <EyeOff className="h-4 w-4 shrink-0" />
        <span className="font-medium">
          Auto-handled by AI{isLoading ? "" : ` (${total})`}
        </span>
        <span className="text-xs">— hidden from the queue; re-open if wrong</span>
      </button>
      {open ? (
        <div className="space-y-4 px-3 pb-3">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              {inaccurate.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                    Flagged inaccurate ({inaccurate.length})
                  </div>
                  {inaccurate.map((p) =>
                    renderRow(
                      p,
                      p.reviewerNote ?? "Flagged inaccurate",
                    ),
                  )}
                </div>
              ) : null}
              {suppressed.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Auto-suppressed ({suppressed.length})
                  </div>
                  {suppressed.map((p) =>
                    renderRow(p, p.reviewerNote ?? "Auto-suppressed"),
                  )}
                </div>
              ) : null}
              {other.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Other ({other.length})
                  </div>
                  {other.map((p) =>
                    renderRow(p, p.reviewerNote ?? "Hidden from queue"),
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <EmailDetailDialog
        emailId={viewEmailId}
        onClose={() => setViewEmailId(null)}
      />
    </div>
  );
}

export type ProposedActionView = {
  type: string;
  reason?: string;
  [k: string]: unknown;
};

function ProposedActionsBlock({
  proposalId,
  actions,
  analyzedAt,
  error,
  checked,
  onToggle,
  onRetry,
  retrying,
}: {
  proposalId: string;
  actions: ProposedActionView[];
  analyzedAt: string | null;
  error: string | null;
  checked: Set<number>;
  onToggle: (idx: number) => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (error) {
    return (
      <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-destructive">
              AI analysis failed
            </div>
            <div className="text-xs text-muted-foreground mt-1">{error}</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={retrying}
            className="shrink-0"
            data-testid={`btn-retry-${proposalId}`}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1.5 ${retrying ? "animate-spin" : ""}`}
            />
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </div>
    );
  }
  if (!analyzedAt) {
    // A pending proposal with no analysis timestamp is normally a brand-
    // new row the inline sync fan-out is actively analyzing. But a row
    // reopened by an operator (or whose claim died mid-flight) lands here
    // permanently: the scheduled recovery sweep only re-attempts rows that
    // carry a stored `actions_error`, so an error-free "Analyzing…" row has
    // no automatic path forward. Surface the same owner-scoped re-analyze
    // control as the failure box so a human can unstick it on demand.
    return (
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground italic">
          Analyzing what to do…
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={retrying}
          className="shrink-0"
          data-testid={`btn-reanalyze-${proposalId}`}
        >
          <RefreshCw
            className={`h-4 w-4 mr-1.5 ${retrying ? "animate-spin" : ""}`}
          />
          {retrying ? "Re-analyzing…" : "Re-analyze"}
        </Button>
      </div>
    );
  }
  if (actions.length === 0) {
    return (
      <div className="mt-4 text-xs text-muted-foreground">
        AI suggested no automatic changes — accepting will just acknowledge this
        signal.
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-md border border-primary/20 bg-primary/5 p-3 space-y-2">
      <div className="text-xs font-semibold text-primary uppercase tracking-wide">
        On accept, the following will happen:
      </div>
      <ul className="space-y-1.5">
        {actions.map((a, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={`action-${proposalId}-${i}`}
              checked={checked.has(i)}
              onCheckedChange={() => onToggle(i)}
              className="mt-0.5"
              aria-label={`Apply: ${describeAction(a)}`}
              data-testid={`checkbox-action-${proposalId}-${i}`}
            />
            <label
              htmlFor={`action-${proposalId}-${i}`}
              className="min-w-0 cursor-pointer"
            >
              <span className="font-medium">{describeAction(a)}</span>
              {a.reason ? (
                <div className="text-xs text-muted-foreground italic mt-0.5">
                  — {a.reason}
                </div>
              ) : null}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function describeAction(a: ProposedActionView): string {
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  const n = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
  const b = (k: string) => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);
  switch (a.type) {
    case "deactivate_per": {
      const title = s("roleTitle");
      const ent = s("roleEntityName");
      const label = [title, ent].filter(Boolean).join(" @ ");
      if (label) return `Mark role inactive: ${label}`;
      return `Mark current role inactive (role id ${s("perId") ?? "?"})`;
    }
    case "create_per": {
      const named = s("entityName");
      const where =
        s("organizationId") ? `funder ${named ? `"${named}"` : s("organizationId")}` :
        s("organizationId") ? `organization ${named ? `"${named}"` : s("organizationId")}` :
        s("paymentIntermediaryId") ? `payment intermediary ${named ? `"${named}"` : s("paymentIntermediaryId")}` :
        s("householdId") ? `household ${named ? `"${named}"` : s("householdId")}` : "(entity?)";
      return `Add new role at ${where}${s("externalTitleOrRole") ? ` as "${s("externalTitleOrRole")}"` : ""}`;
    }
    case "create_person_with_per": {
      const where =
        s("organizationId") ? ` at funder ${s("organizationId")}` :
        s("organizationId") ? ` at organization ${s("organizationId")}` : "";
      const role = s("externalTitleOrRole") ? ` as "${s("externalTitleOrRole")}"` : "";
      const email = s("emailAddress") ? ` (${s("emailAddress")})` : "";
      return `Create person ${s("firstName") ?? ""} ${s("lastName") ?? ""}${email}${where}${role}`;
    }
    case "create_org_with_per": {
      const role = s("externalTitleOrRole") ? ` as "${s("externalTitleOrRole")}"` : "";
      const kind = s("organizationType") ? ` (${s("organizationType")})` : "";
      return `Create organization "${s("organizationName") ?? "?"}"${kind} and add role${role}`;
    }
    case "create_funder_with_per": {
      const role = s("externalTitleOrRole") ? ` as "${s("externalTitleOrRole")}"` : "";
      return `Create funder "${s("funderName") ?? "?"}" and add role${role}`;
    }
    case "add_email":
      return `Add email ${s("emailAddress")} to ${s("personName") ?? s("organizationName") ?? "person"}${b("setPrimary") ? " (and make it primary)" : ""}`;
    case "set_primary_email": {
      const who = s("personName") ?? s("organizationName");
      return `Promote ${s("emailAddress") ?? s("emailId") ?? "an email"} to primary${who ? ` for ${who}` : ""}`;
    }
    case "mark_email_invalid":
      return `Mark ${s("emailAddress")} as invalid (bounced)`;
    case "create_grant_opportunity": {
      const amt = n("askAmount");
      const parts = [`Create grant opportunity "${s("title")}"`];
      if (s("organizationId") || s("funderName")) parts.push(`at ${s("funderName") ?? s("organizationId")}`);
      if (amt) parts.push(`ask $${amt.toLocaleString()}`);
      if (s("deadline")) parts.push(`due ${s("deadline")}`);
      return parts.join(", ");
    }
    case "set_phone":
      return `Add phone ${s("phoneNumber")}${s("phoneType") ? ` (${s("phoneType")})` : ""} to ${s("personName") ?? s("organizationName") ?? "person"}${b("setPrimary") ? " (and make it primary)" : ""}`;
    case "update_per_title": {
      const ent = s("roleEntityName");
      if (ent) return `Update role title to "${s("externalTitleOrRole")}" @ ${ent}`;
      return `Update role title to "${s("externalTitleOrRole")}" (role id ${s("perId") ?? "?"})`;
    }
    default:
      return a.type;
  }
}

function summarizeProposal(p: {
  kind: string;
  subjectName?: string | null;
  subjectEmail?: string | null;
  payload?: Record<string, unknown>;
}): string {
  const payload = (p.payload ?? {}) as Record<string, unknown>;
  switch (p.kind) {
    case "linkedin_job_change":
      return [
        p.subjectName ?? (payload.personName as string | undefined) ?? "Someone",
        "→",
        (payload.newTitle as string | undefined) ?? "new role",
        "at",
        (payload.newCompany as string | undefined) ?? "?",
      ].join(" ");
    case "auto_responder_move":
      return `${p.subjectEmail ?? "Someone"} → ${
        (payload.newCompany as string | undefined) ??
        (payload.newEmail as string | undefined) ??
        "moved"
      }`;
    case "bounce_invalid":
      return `Hard bounce: ${p.subjectEmail ?? "?"}`;
    case "bounce_soft":
      return `Soft bounce: ${p.subjectEmail ?? "?"}`;
    case "signature_update":
      return `Signature update: ${p.subjectName ?? p.subjectEmail ?? "Someone"}`;
    case "thank_you_acknowledgment": {
      const funder = (payload.funderName as string | undefined) ?? p.subjectName;
      const amount = payload.giftAmount as number | undefined;
      const parts = ["Thank-you ack"];
      if (funder) parts.push(`— ${funder}`);
      if (amount) parts.push(`($${amount.toLocaleString()})`);
      return parts.join(" ");
    }
    case "wildflower_update": {
      const flavor = payload.flavor as string | undefined;
      if (flavor === "donor_outreach") {
        return `Wildflower outreach: ${
          (payload.title as string | undefined) ??
          p.subjectName ??
          "donor follow-up"
        }`;
      }
      if (flavor === "note_revision") {
        return "Wildflower note revision proposed";
      }
      return "Wildflower update";
    }
    default:
      return p.subjectName ?? p.subjectEmail ?? p.kind;
  }
}

function ProposalDetail({
  kind,
  payload,
}: {
  kind: string;
  payload: Record<string, unknown>;
}) {
  const cell = (label: string, value: unknown) =>
    value === null || value === undefined || value === "" ? null : (
      <div key={label} className="text-sm">
        <span className="text-muted-foreground mr-2">{label}:</span>
        <span className="font-medium">{String(value)}</span>
      </div>
    );

  switch (kind) {
    case "linkedin_job_change":
      return (
        <div className="space-y-1">
          {cell("New title", payload.newTitle)}
          {cell("New company", payload.newCompany)}
          {cell("Match", payload.matchConfidence)}
          {payload.sourceLine ? (
            <p className="text-xs italic text-muted-foreground border-l-2 pl-2 mt-2">
              "{String(payload.sourceLine)}"
            </p>
          ) : null}
        </div>
      );
    case "auto_responder_move":
      return (
        <div className="space-y-1">
          {cell("Left", payload.leftCompany)}
          {cell("New company", payload.newCompany)}
          {cell("New email", payload.newEmail)}
          {payload.quotedSnippet ? (
            <p className="text-xs italic text-muted-foreground border-l-2 pl-2 mt-2">
              "{String(payload.quotedSnippet)}"
            </p>
          ) : null}
        </div>
      );
    case "bounce_invalid":
    case "bounce_soft":
      return (
        <div className="space-y-1">
          {cell("Recipient", payload.recipient)}
          {cell("SMTP code", payload.smtpCode)}
          {cell("Status code", payload.enhancedCode)}
          {cell("Reason", payload.reason)}
        </div>
      );
    case "thank_you_acknowledgment":
      return (
        <div className="space-y-1">
          {cell("Gift", payload.giftId)}
          {cell("Funder", payload.funderName)}
          {cell("Amount", payload.giftAmount)}
          {cell("Attachments", Array.isArray(payload.attachmentIds) ? (payload.attachmentIds as unknown[]).length : undefined)}
        </div>
      );
    case "signature_update": {
      const parsed = (payload.parsed ?? {}) as Record<string, unknown>;
      return (
        <div className="space-y-1">
          {cell("Name", parsed.name)}
          {cell("Title", parsed.title)}
          {cell("Company", parsed.company)}
          {cell("Phone", parsed.phone)}
          {cell("Email", parsed.email)}
          {payload.companyDrift ? (
            <Badge variant="outline" className="mt-2">
              Company differs from CRM
            </Badge>
          ) : null}
        </div>
      );
    }
    case "wildflower_update": {
      const flavor = payload.flavor as string | undefined;
      if (flavor === "donor_outreach") {
        return (
          <div className="space-y-1">
            <Badge variant="outline" className="mb-1">Donor outreach</Badge>
            {cell("Task", payload.title)}
            {cell("Guidance", payload.description)}
            {payload.rationale ? (
              <p className="text-xs italic text-muted-foreground border-l-2 pl-2 mt-2">
                {String(payload.rationale)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground mt-2">
              Accept creates a cultivation task linked to this donor.
            </p>
          </div>
        );
      }
      if (flavor === "note_revision") {
        return (
          <div className="space-y-1">
            <Badge variant="outline" className="mb-1">Note revision</Badge>
            {payload.rationale ? (
              <p className="text-xs italic text-muted-foreground border-l-2 pl-2 mb-2">
                {String(payload.rationale)}
              </p>
            ) : null}
            <div className="text-xs text-muted-foreground">Proposed note:</div>
            <pre className="text-sm whitespace-pre-wrap rounded bg-muted p-2 mt-1">
              {String(payload.proposedContent ?? "")}
            </pre>
            <p className="text-xs text-muted-foreground mt-2">
              Accept overwrites the shared Wildflower updates note.
            </p>
          </div>
        );
      }
      return null;
    }
    default:
      return null;
  }
}

function UnrecognizedCorrespondents() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError } = useListUnrecognizedCorrespondents(
    undefined,
    {
      query: { queryKey: getListUnrecognizedCorrespondentsQueryKey() },
    },
  );

  // Per-row "link to person" state: which email address is currently
  // showing the inline picker, and which person id has been selected.
  const [linkingEmail, setLinkingEmail] = useState<string | null>(null);
  const [linkPersonId, setLinkPersonId] = useState<string | null>(null);

  const invalidateCorrespondents = () =>
    void qc.invalidateQueries({
      queryKey: getListUnrecognizedCorrespondentsQueryKey(),
    });

  const ignore = useCreateCorrespondentIgnore({
    mutation: {
      onSuccess: () => {
        invalidateCorrespondents();
        toast({ title: "Hidden from this list" });
      },
      onError: (e) =>
        toast({
          title: "Could not ignore",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const linkEmail = useCreateEmail({
    mutation: {
      onSuccess: (_data, variables) => {
        invalidateCorrespondents();
        // Also invalidate the person's record so their email list
        // reflects the newly attached address immediately.
        void qc.invalidateQueries();
        const addr = (variables.data as { email?: string }).email ?? "";
        toast({ title: `Email linked`, description: addr ? `"${addr}" added to person` : undefined });
        setLinkingEmail(null);
        setLinkPersonId(null);
      },
      onError: (e) =>
        toast({
          title: "Could not link email",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const startLinking = (emailAddress: string) => {
    setLinkingEmail(emailAddress);
    setLinkPersonId(null);
  };

  const cancelLinking = () => {
    setLinkingEmail(null);
    setLinkPersonId(null);
  };

  const confirmLink = (emailAddress: string) => {
    if (!linkPersonId) return;
    linkEmail.mutate({ data: { email: emailAddress, personId: linkPersonId } });
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (isError) {
    return <div className="text-sm text-destructive">Failed to load.</div>;
  }
  const rows = data?.data ?? [];
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nobody outside the CRM you've been emailing repeatedly. Nice
          inbox hygiene.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          People you've been emailing who aren't in the CRM
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {rows.map((r) => (
            <li
              key={r.emailAddress}
              className="px-4 py-3 space-y-2"
              data-testid={`correspondent-${r.emailAddress}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{r.emailAddress}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.threadCount} thread{r.threadCount === 1 ? "" : "s"} ·
                    last on {new Date(r.lastSeenAt).toLocaleDateString()}
                    {r.lastSubject ? ` · "${r.lastSubject}"` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Link
                    href={`/individuals?createFromEmail=${encodeURIComponent(
                      r.emailAddress,
                    )}`}
                    className="text-xs text-primary hover:underline"
                  >
                    Create person
                  </Link>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={linkEmail.isPending}
                    onClick={() => startLinking(r.emailAddress)}
                    data-testid={`btn-link-${r.emailAddress}`}
                  >
                    Link to existing person
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ignore.isPending}
                    onClick={() =>
                      ignore.mutate({ data: { emailAddress: r.emailAddress } })
                    }
                    data-testid={`btn-ignore-${r.emailAddress}`}
                  >
                    Ignore
                  </Button>
                </div>
              </div>

              {linkingEmail === r.emailAddress ? (
                <LinkToPersonInline
                  emailAddress={r.emailAddress}
                  selectedPersonId={linkPersonId}
                  onPersonChange={setLinkPersonId}
                  onConfirm={() => confirmLink(r.emailAddress)}
                  onCancel={cancelLinking}
                  isPending={linkEmail.isPending}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function LinkToPersonInline({
  emailAddress,
  selectedPersonId,
  onPersonChange,
  onConfirm,
  onCancel,
  isPending,
}: {
  emailAddress: string;
  selectedPersonId: string | null;
  onPersonChange: (id: string | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const resolvedName = usePersonName(selectedPersonId);
  return (
    <div
      className="flex items-center gap-2 pl-1"
      data-testid={`link-picker-${emailAddress}`}
    >
      <div className="flex-1 min-w-0">
        <EntityCombobox
          useSearch={usePersonSearch}
          useResolve={usePersonName}
          value={selectedPersonId}
          onChange={onPersonChange}
          placeholder="Search people…"
          allowNull={false}
          testId={`combobox-link-person-${emailAddress}`}
        />
      </div>
      <Button
        size="sm"
        disabled={!selectedPersonId || isPending}
        onClick={onConfirm}
        data-testid={`btn-confirm-link-${emailAddress}`}
      >
        {isPending ? "Linking…" : `Link${resolvedName ? ` to ${resolvedName}` : ""}`}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={isPending}
        onClick={onCancel}
        data-testid={`btn-cancel-link-${emailAddress}`}
      >
        Cancel
      </Button>
    </div>
  );
}
