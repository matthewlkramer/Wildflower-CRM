import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  CheckCircle2,
  ImageOff,
  Loader2,
  MessageSquare,
  Pencil,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useToast } from "@/hooks/use-toast";
import {
  implementAppFeedbackProposal,
  listAppFeedback,
  reviseAppFeedbackProposal,
  updateAppFeedback,
  type AppFeedbackItem,
  type FeedbackCategory,
  type FeedbackContext,
  type FeedbackStatus,
} from "@/lib/feedback-api";

const PAGE_SIZE = 50;

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function categoryLabel(category: FeedbackCategory): string {
  return {
    bug: "Problem",
    question: "Question",
    suggestion: "Suggestion",
    other: "Other",
  }[category];
}

function statusLabel(status: FeedbackStatus): string {
  return {
    open: "Open",
    in_progress: "In progress",
    resolved: "Resolved",
    dismissed: "Dismissed",
  }[status];
}

function statusVariant(
  status: FeedbackStatus,
): "default" | "secondary" | "outline" {
  if (status === "open") return "default";
  if (status === "in_progress") return "secondary";
  return "outline";
}

function proposalStatusLabel(
  status: NonNullable<AppFeedbackItem["proposal"]>["generationStatus"],
): string {
  return {
    queued: "Queued",
    generating: "Generating",
    ready: "Ready",
    error: "Needs retry",
  }[status];
}

export default function AdminFeedback() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<FeedbackStatus | "all">("open");
  const [category, setCategory] = useState<FeedbackCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AppFeedbackItem | null>(null);
  const [editStatus, setEditStatus] = useState<FeedbackStatus>("open");
  const [adminNotes, setAdminNotes] = useState("");
  const [showRevision, setShowRevision] = useState(false);
  const [revisionGuidance, setRevisionGuidance] = useState("");
  const [confirmImplementation, setConfirmImplementation] = useState(false);

  useEffect(() => setPage(1), [status, category, search]);
  useEffect(() => {
    if (!selected) return;
    setEditStatus(selected.status);
    setAdminNotes(selected.adminNotes ?? "");
    setShowRevision(false);
    setRevisionGuidance("");
    setConfirmImplementation(false);
  }, [selected]);

  const queryKey = useMemo(
    () => ["admin-feedback", status, category, search, page] as const,
    [status, category, search, page],
  );
  const feedbackQuery = useQuery({
    queryKey,
    enabled: isAdmin,
    queryFn: () =>
      listAppFeedback({
        status,
        category,
        search: search.trim() || undefined,
        page,
        limit: PAGE_SIZE,
      }),
    refetchInterval: (query) => {
      const items = query.state.data?.data ?? [];
      return items.some(
        (item) =>
          !item.proposal ||
          item.proposal.generationStatus === "queued" ||
          item.proposal.generationStatus === "generating",
      )
        ? 3_000
        : false;
    },
  });
  useEffect(() => {
    if (!feedbackQuery.data) return;
    setSelected((current) => {
      if (!current) return current;
      return (
        feedbackQuery.data.data.find((item) => item.id === current.id) ??
        current
      );
    });
  }, [feedbackQuery.data]);
  const updateMutation = useMutation({
    mutationFn: ({
      id,
      nextStatus,
      notes,
    }: {
      id: string;
      nextStatus: FeedbackStatus;
      notes: string;
    }) =>
      updateAppFeedback(id, {
        status: nextStatus,
        adminNotes: notes.trim() || null,
      }),
    onSuccess: (updated) => {
      setSelected(updated);
      void queryClient.invalidateQueries({ queryKey: ["admin-feedback"] });
      toast({ title: "Feedback updated" });
    },
    onError: (error) => {
      toast({
        title: "Could not update feedback",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });
  const reviseMutation = useMutation({
    mutationFn: ({ id, guidance }: { id: string; guidance: string }) =>
      reviseAppFeedbackProposal(id, guidance),
    onSuccess: (updated) => {
      setSelected(updated);
      setShowRevision(false);
      setRevisionGuidance("");
      void queryClient.invalidateQueries({ queryKey: ["admin-feedback"] });
      toast({ title: "Proposal regenerated" });
    },
    onError: (error) => {
      toast({
        title: "Could not regenerate proposal",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });
  const implementMutation = useMutation({
    mutationFn: (id: string) => implementAppFeedbackProposal(id),
    onSuccess: async (updated) => {
      setSelected(updated);
      setConfirmImplementation(false);
      void queryClient.invalidateQueries({ queryKey: ["admin-feedback"] });
      const brief = updated.proposal?.proposal?.implementationBrief;
      let copied = false;
      if (brief && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(brief);
          copied = true;
        } catch {
          copied = false;
        }
      }
      toast({
        title: copied
          ? "Implementation brief copied"
          : "Implementation handoff prepared",
        description: copied
          ? "The item is in progress. Paste the brief into Codex or Replit."
          : "The item is in progress. The coding-agent brief remains visible in the proposal.",
      });
    },
    onError: (error) => {
      toast({
        title: "Could not prepare implementation",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  if (!isAdmin) {
    return (
      <Card className="max-w-xl">
        <CardContent className="pt-6">
          <p className="font-medium">Admin access required</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Only administrators can review submitted product feedback.
          </p>
        </CardContent>
      </Card>
    );
  }

  const data = feedbackQuery.data?.data ?? [];
  const total = feedbackQuery.data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const context = selected?.context as FeedbackContext | undefined;

  return (
    <div className="max-w-7xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-serif font-bold">
          <MessageSquare className="h-7 w-7 text-primary" />
          Feedback
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review questions and issues submitted from inside the CRM, including
          page state and a private screenshot when capture succeeded.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search message, page, or reporter…"
          className="max-w-sm"
        />
        <Select
          value={status}
          onValueChange={(value) => setStatus(value as FeedbackStatus | "all")}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_progress">In progress</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={category}
          onValueChange={(value) =>
            setCategory(value as FeedbackCategory | "all")
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="bug">Problems</SelectItem>
            <SelectItem value="question">Questions</SelectItem>
            <SelectItem value="suggestion">Suggestions</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {total.toLocaleString()} items
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Submitted</TableHead>
              <TableHead className="w-44">Reporter</TableHead>
              <TableHead className="w-28">Type</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-52">Page</TableHead>
              <TableHead className="w-32">Proposal</TableHead>
              <TableHead className="w-32">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {feedbackQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-10 text-center text-muted-foreground"
                >
                  No feedback matches these filters.
                </TableCell>
              </TableRow>
            ) : (
              data.map((item) => (
                <TableRow
                  key={item.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(item)}
                >
                  <TableCell className="text-xs">
                    {fmtDate(item.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">
                      {item.reporter.name ?? "Unknown user"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {item.reporter.email}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {categoryLabel(item.category)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <p className="line-clamp-2 max-w-xl whitespace-pre-wrap text-sm">
                      {item.message}
                    </p>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.pagePath}
                  </TableCell>
                  <TableCell>
                    {item.proposal ? (
                      <Badge
                        variant={
                          item.proposal.generationStatus === "ready"
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {proposalStatusLabel(item.proposal.generationStatus)}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Queued</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(item.status)}>
                      {statusLabel(item.status)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          disabled={page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          disabled={page >= totalPages}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </Button>
      </div>

      <Dialog
        open={selected != null}
        onOpenChange={(next) => !next && setSelected(null)}
      >
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {categoryLabel(selected.category)}
                  </Badge>
                  Feedback from{" "}
                  {selected.reporter.name ??
                    selected.reporter.email ??
                    "a user"}
                </DialogTitle>
                <DialogDescription>
                  Submitted {fmtDate(selected.createdAt)} from{" "}
                  {selected.pagePath}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
                <div className="space-y-5">
                  <section>
                    <h3 className="text-sm font-semibold">Issue or question</h3>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 text-sm">
                      {selected.message}
                    </p>
                  </section>
                  <section className="space-y-4 rounded-lg border bg-primary/[0.025] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-primary" />
                        <h3 className="text-sm font-semibold">
                          Implementation proposal
                        </h3>
                        {selected.proposal ? (
                          <Badge variant="outline">
                            Version {selected.proposal.revision}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {selected.proposal?.implementationRequestedAt ? (
                          <Badge variant="secondary">
                            Implementation prepared
                          </Badge>
                        ) : null}
                        {selected.viewerCanImplement &&
                        selected.proposal?.generationStatus === "ready" &&
                        selected.proposal.proposal ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => setConfirmImplementation(true)}
                            disabled={
                              implementMutation.isPending ||
                              Boolean(
                                selected.proposal.implementationRequestedAt,
                              )
                            }
                          >
                            <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                            Start implementation
                          </Button>
                        ) : null}
                        {selected.proposal &&
                        (selected.proposal.generationStatus === "ready" ||
                          selected.proposal.generationStatus === "error") ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setShowRevision((value) => !value)}
                            disabled={
                              reviseMutation.isPending ||
                              Boolean(
                                selected.proposal.implementationRequestedAt,
                              )
                            }
                          >
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Modify proposal
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {!selected.viewerCanImplement &&
                    selected.proposal?.generationStatus === "ready" &&
                    !selected.proposal.implementationRequestedAt ? (
                      <p className="text-xs text-muted-foreground">
                        Only the designated Codex owner can start
                        implementation. Administrators can still review and
                        modify this proposal.
                      </p>
                    ) : null}

                    {!selected.proposal ||
                    selected.proposal.generationStatus === "queued" ||
                    selected.proposal.generationStatus === "generating" ? (
                      <div className="flex items-center gap-2 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Generating a proposal from the feedback and captured
                        page context…
                      </div>
                    ) : selected.proposal.generationStatus === "error" ? (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                        <p className="font-medium">
                          Proposal generation failed
                        </p>
                        <p className="mt-1 text-muted-foreground">
                          {selected.proposal.error ??
                            "Add guidance below to try again."}
                        </p>
                      </div>
                    ) : selected.proposal.proposal ? (
                      <div className="space-y-4 text-sm">
                        <div>
                          <h4 className="font-semibold">
                            {selected.proposal.proposal.title}
                          </h4>
                          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                            {selected.proposal.proposal.summary}
                          </p>
                        </div>

                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            User experience
                          </h4>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            {selected.proposal.proposal.userExperience.map(
                              (item, index) => (
                                <li key={`${index}-${item}`}>{item}</li>
                              ),
                            )}
                          </ul>
                        </div>

                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Proposed changes
                          </h4>
                          <ol className="mt-2 list-decimal space-y-1 pl-5">
                            {selected.proposal.proposal.implementationSteps.map(
                              (item, index) => (
                                <li key={`${index}-${item}`}>{item}</li>
                              ),
                            )}
                          </ol>
                        </div>

                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Likely areas
                          </h4>
                          <div className="mt-2 space-y-2">
                            {selected.proposal.proposal.likelyCodeAreas.map(
                              (item) => (
                                <div
                                  key={item.area}
                                  className="rounded-md bg-muted/40 p-2"
                                >
                                  <p className="font-medium">{item.area}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {item.rationale}
                                  </p>
                                </div>
                              ),
                            )}
                          </div>
                        </div>

                        <div>
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Acceptance criteria
                          </h4>
                          <ul className="mt-2 list-disc space-y-1 pl-5">
                            {selected.proposal.proposal.acceptanceCriteria.map(
                              (item, index) => (
                                <li key={`${index}-${item}`}>{item}</li>
                              ),
                            )}
                          </ul>
                        </div>

                        <details className="rounded-md border p-3">
                          <summary className="cursor-pointer font-medium">
                            Test plan and open questions
                          </summary>
                          <div className="mt-3 space-y-3">
                            <ul className="list-disc space-y-1 pl-5">
                              {selected.proposal.proposal.testPlan.map(
                                (item, index) => (
                                  <li key={`${index}-${item}`}>{item}</li>
                                ),
                              )}
                            </ul>
                            {selected.proposal.proposal.risksAndOpenQuestions
                              .length ? (
                              <>
                                <p className="font-medium">Open questions</p>
                                <ul className="list-disc space-y-1 pl-5">
                                  {selected.proposal.proposal.risksAndOpenQuestions.map(
                                    (item, index) => (
                                      <li key={`${index}-${item}`}>{item}</li>
                                    ),
                                  )}
                                </ul>
                              </>
                            ) : null}
                          </div>
                        </details>
                        <details className="rounded-md border p-3">
                          <summary className="cursor-pointer font-medium">
                            Coding-agent brief
                          </summary>
                          <p className="mt-2 text-xs text-muted-foreground">
                            This is the self-contained handoff used by the Start
                            implementation button.
                          </p>
                          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">
                            {selected.proposal.proposal.implementationBrief}
                          </pre>
                        </details>
                      </div>
                    ) : null}

                    {showRevision ? (
                      <div className="space-y-3 rounded-md border bg-background p-3">
                        <div>
                          <Label htmlFor="feedback-proposal-guidance">
                            What should the proposal change?
                          </Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Your guidance is kept with the proposal and used to
                            recreate the full plan.
                          </p>
                        </div>
                        <Textarea
                          id="feedback-proposal-guidance"
                          value={revisionGuidance}
                          onChange={(event) =>
                            setRevisionGuidance(event.target.value)
                          }
                          rows={5}
                          maxLength={20_000}
                          placeholder="For example: keep the existing table layout, and make this available only to admins…"
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setShowRevision(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            onClick={() =>
                              reviseMutation.mutate({
                                id: selected.id,
                                guidance: revisionGuidance.trim(),
                              })
                            }
                            disabled={
                              !revisionGuidance.trim() ||
                              reviseMutation.isPending
                            }
                          >
                            {reviseMutation.isPending ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Sparkles className="mr-2 h-4 w-4" />
                            )}
                            Recreate proposal
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </section>
                  <section>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">Screenshot</h3>
                      {selected.screenshotUrl ? (
                        <a
                          href={selected.screenshotUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Open full size <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                    {selected.screenshotUrl ? (
                      <a
                        href={selected.screenshotUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          src={selected.screenshotUrl}
                          alt="Submitted feedback screenshot"
                          className="mt-2 max-h-[520px] w-full rounded-lg border object-contain"
                        />
                      </a>
                    ) : (
                      <div className="mt-2 flex min-h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                        <ImageOff className="mr-2 h-4 w-4" />
                        {selected.screenshotError
                          ? `Capture failed: ${selected.screenshotError}`
                          : "No screenshot included"}
                      </div>
                    )}
                  </section>
                </div>

                <div className="space-y-5">
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Page context</h3>
                    <a
                      href={selected.pageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all text-sm text-primary hover:underline"
                    >
                      {selected.pageUrl}
                    </a>
                    {context ? (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <p>
                          Viewport: {context.viewport?.width ?? "?"}×
                          {context.viewport?.height ?? "?"}
                        </p>
                        <p>
                          Scroll: {context.scroll?.x ?? "?"},{" "}
                          {context.scroll?.y ?? "?"}
                        </p>
                        <p>Tabs: {context.activeTabs?.join(", ") || "none"}</p>
                        <p>
                          Visible records/elements:{" "}
                          {context.visibleTestIds?.length ?? 0}
                        </p>
                      </div>
                    ) : null}
                    <details className="rounded border p-2 text-xs">
                      <summary className="cursor-pointer font-medium">
                        Full captured state
                      </summary>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[10px]">
                        {JSON.stringify(selected.context, null, 2)}
                      </pre>
                    </details>
                  </section>

                  <section className="space-y-3 rounded-lg border p-4">
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <Select
                        value={editStatus}
                        onValueChange={(value) =>
                          setEditStatus(value as FeedbackStatus)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="open">Open</SelectItem>
                          <SelectItem value="in_progress">
                            In progress
                          </SelectItem>
                          <SelectItem value="resolved">Resolved</SelectItem>
                          <SelectItem value="dismissed">Dismissed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="feedback-admin-notes">Admin notes</Label>
                      <Textarea
                        id="feedback-admin-notes"
                        value={adminNotes}
                        onChange={(event) => setAdminNotes(event.target.value)}
                        rows={8}
                        placeholder="Investigation, decision, or follow-up…"
                      />
                    </div>
                    {selected.resolver ? (
                      <p className="text-xs text-muted-foreground">
                        Last resolved by{" "}
                        {selected.resolver.name ?? selected.resolver.email}{" "}
                        {selected.resolvedAt
                          ? `on ${fmtDate(selected.resolvedAt)}`
                          : ""}
                      </p>
                    ) : null}
                  </section>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setSelected(null)}>
                  Close
                </Button>
                <Button
                  onClick={() =>
                    updateMutation.mutate({
                      id: selected.id,
                      nextStatus: editStatus,
                      notes: adminNotes,
                    })
                  }
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Save
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmImplementation}
        onOpenChange={setConfirmImplementation}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start this implementation?</AlertDialogTitle>
            <AlertDialogDescription>
              The CRM cannot safely edit or publish its own source code. This
              will mark the feedback item in progress, record your approval, and
              copy a complete implementation brief for Codex or Replit. Code
              review, tests, migration approval, and publishing remain separate
              human-gated steps.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={implementMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (selected?.viewerCanImplement) {
                  implementMutation.mutate(selected.id);
                }
              }}
              disabled={
                !selected?.viewerCanImplement || implementMutation.isPending
              }
            >
              {implementMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Mark in progress and copy brief
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
