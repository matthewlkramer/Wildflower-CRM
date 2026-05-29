import { useMemo, useState } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEmailProposals,
  useAcceptEmailProposal,
  useRejectEmailProposal,
  useListUnrecognizedCorrespondents,
  useCreateCorrespondentIgnore,
  getListEmailProposalsQueryKey,
  getGetEmailProposalSummaryQueryKey,
  getListUnrecognizedCorrespondentsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { EmailDetailDialog } from "@/components/email-detail-dialog";
import { Mail } from "lucide-react";

type Kind =
  | "linkedin_job_change"
  | "auto_responder_move"
  | "bounce_invalid"
  | "bounce_soft"
  | "signature_update"
  | "grant_opportunity"
  | "thank_you_acknowledgment";

const KIND_TABS: { value: Kind; label: string }[] = [
  { value: "linkedin_job_change", label: "Job changes" },
  { value: "auto_responder_move", label: "Moved (auto-reply)" },
  { value: "bounce_invalid", label: "Hard bounces" },
  { value: "bounce_soft", label: "Soft bounces" },
  { value: "signature_update", label: "Signature updates" },
  { value: "grant_opportunity", label: "Grant opportunities" },
  { value: "thank_you_acknowledgment", label: "Thank-you acks" },
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
  } | null>(null);
  const [reviewerNote, setReviewerNote] = useState("");
  const [viewEmailId, setViewEmailId] = useState<string | null>(null);
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
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nothing pending in this category.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid={`proposal-list-${kind}`}>
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
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {p.targetPersonId ? (
                <Link
                  href={`/individuals/${p.targetPersonId}`}
                  className="text-xs text-primary hover:underline"
                >
                  View person
                </Link>
              ) : null}
              {p.sourceMessageId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setViewEmailId(p.sourceMessageId ?? null)}
                  data-testid={`btn-view-email-${p.id}`}
                >
                  <Mail className="h-3.5 w-3.5 mr-1" />
                  View email
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={reject.isPending}
                onClick={() => {
                  setReviewerNote("");
                  setNoteTarget({
                    id: p.id,
                    summary: summarizeProposal(p),
                    mode: "reject",
                  });
                }}
                data-testid={`btn-reject-${p.id}`}
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                disabled={accept.isPending}
                onClick={() => {
                  setReviewerNote("");
                  setNoteTarget({
                    id: p.id,
                    summary: summarizeProposal(p),
                    mode: "accept",
                  });
                }}
                data-testid={`btn-accept-${p.id}`}
              >
                Accept
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <ProposalDetail kind={kind} payload={p.payload ?? {}} />
            <ProposedActionsBlock
              actions={(p.proposedActions ?? []) as ProposedActionView[]}
              analyzedAt={p.actionsAnalyzedAt ?? null}
              error={p.actionsError ?? null}
            />
          </CardContent>
        </Card>
      ))}
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
                const data = note ? { reviewerNote: note } : {};
                if (noteTarget.mode === "accept") {
                  accept.mutate({ id: noteTarget.id, data });
                } else {
                  reject.mutate({ id: noteTarget.id, data });
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
      <EmailDetailDialog
        emailId={viewEmailId}
        onClose={() => setViewEmailId(null)}
      />
    </div>
  );
}

type ProposedActionView = {
  type: string;
  reason?: string;
  [k: string]: unknown;
};

function ProposedActionsBlock({
  actions,
  analyzedAt,
  error,
}: {
  actions: ProposedActionView[];
  analyzedAt: string | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="text-xs font-medium text-destructive">
          AI analysis failed
        </div>
        <div className="text-xs text-muted-foreground mt-1">{error}</div>
      </div>
    );
  }
  if (!analyzedAt) {
    return (
      <div className="mt-4 text-xs text-muted-foreground italic">
        Analyzing what to do…
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
          <li key={i} className="text-sm">
            <span className="font-medium">{describeAction(a)}</span>
            {a.reason ? (
              <div className="text-xs text-muted-foreground italic mt-0.5">
                — {a.reason}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function describeAction(a: ProposedActionView): string {
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  const n = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
  const b = (k: string) => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);
  switch (a.type) {
    case "deactivate_per":
      return `Mark current role inactive (role id ${s("perId") ?? "?"})`;
    case "create_per": {
      const where =
        s("funderId") ? `funder ${s("funderId")}` :
        s("organizationId") ? `organization ${s("organizationId")}` :
        s("paymentIntermediaryId") ? `payment intermediary ${s("paymentIntermediaryId")}` :
        s("householdId") ? `household ${s("householdId")}` : "(entity?)";
      return `Add new role at ${where}${s("externalTitleOrRole") ? ` as "${s("externalTitleOrRole")}"` : ""}`;
    }
    case "create_person_with_per": {
      const where =
        s("funderId") ? ` at funder ${s("funderId")}` :
        s("organizationId") ? ` at organization ${s("organizationId")}` : "";
      const role = s("externalTitleOrRole") ? ` as "${s("externalTitleOrRole")}"` : "";
      const email = s("emailAddress") ? ` (${s("emailAddress")})` : "";
      return `Create person ${s("firstName") ?? ""} ${s("lastName") ?? ""}${email}${where}${role}`;
    }
    case "add_email":
      return `Add email ${s("emailAddress")} to person${b("setPrimary") ? " (and make it primary)" : ""}`;
    case "set_primary_email":
      return `Promote ${s("emailAddress") ?? s("emailId") ?? "an email"} to primary`;
    case "mark_email_invalid":
      return `Mark ${s("emailAddress")} as invalid (bounced)`;
    case "create_grant_opportunity": {
      const amt = n("askAmount");
      const parts = [`Create grant opportunity "${s("title")}"`];
      if (s("funderId") || s("funderName")) parts.push(`at ${s("funderName") ?? s("funderId")}`);
      if (amt) parts.push(`ask $${amt.toLocaleString()}`);
      if (s("deadline")) parts.push(`due ${s("deadline")}`);
      return parts.join(", ");
    }
    case "set_phone":
      return `Add phone ${s("phoneNumber")}${s("phoneType") ? ` (${s("phoneType")})` : ""} to person${b("setPrimary") ? " (and make it primary)" : ""}`;
    case "update_per_title":
      return `Update role title to "${s("externalTitleOrRole")}" (role id ${s("perId") ?? "?"})`;
    default:
      return a.type;
  }
}

function summarizeProposal(p: {
  kind: Kind;
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
    case "grant_opportunity": {
      const title = (payload.title as string | undefined) ?? "Grant opportunity";
      const funder = (payload.funderName as string | undefined) ?? p.subjectName;
      const deadline = payload.deadline as string | undefined;
      const parts = [title];
      if (funder) parts.push(`— ${funder}`);
      if (deadline) parts.push(`(due ${deadline})`);
      return parts.join(" ");
    }
    case "thank_you_acknowledgment": {
      const funder = (payload.funderName as string | undefined) ?? p.subjectName;
      const amount = payload.giftAmount as number | undefined;
      const parts = ["Thank-you ack"];
      if (funder) parts.push(`— ${funder}`);
      if (amount) parts.push(`($${amount.toLocaleString()})`);
      return parts.join(" ");
    }
  }
}

function ProposalDetail({
  kind,
  payload,
}: {
  kind: Kind;
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
    case "grant_opportunity": {
      const url = payload.url as string | undefined;
      return (
        <div className="space-y-1">
          {cell("Title", payload.title)}
          {cell("Funder", payload.funderName)}
          {cell("Deadline", payload.deadline)}
          {cell("Amount", payload.amount)}
          {url ? (
            <div className="text-sm">
              <span className="text-muted-foreground mr-2">Link:</span>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline break-all"
              >
                {url}
              </a>
            </div>
          ) : null}
          {cell("Source", payload.sourceDigest)}
          {payload.snippet ? (
            <p className="text-xs italic text-muted-foreground border-l-2 pl-2 mt-2">
              "{String(payload.snippet)}"
            </p>
          ) : null}
        </div>
      );
    }
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

  const ignore = useCreateCorrespondentIgnore({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({
          queryKey: getListUnrecognizedCorrespondentsQueryKey(),
        });
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
              className="flex items-center justify-between gap-3 px-4 py-3"
              data-testid={`correspondent-${r.emailAddress}`}
            >
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
                  disabled={ignore.isPending}
                  onClick={() =>
                    ignore.mutate({ data: { emailAddress: r.emailAddress } })
                  }
                  data-testid={`btn-ignore-${r.emailAddress}`}
                >
                  Ignore
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
