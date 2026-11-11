import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import {
  addDevelopmentAgendaItem,
  createDevelopmentMeeting,
  getGetFundraisingBriefQueryKey,
  getListDevelopmentMeetingsQueryKey,
  requestFunderScan,
  reviewFundraisingFinding,
  useGetCurrentUser,
  useGetFundraisingBrief,
  useListDevelopmentMeetings,
  type FundraisingFinding,
} from "@workspace/api-client-react";
import {
  ContactPicker,
  type PickedContact,
} from "@/components/meeting-notes-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";

const CATEGORIES = {
  funding_opportunity: "Funding opportunity",
  strategy_priorities: "Strategy & priorities",
  leadership_staff: "Leadership & staff",
  general_news: "General news",
};

const CADENCE = {
  weekly: "Weekly",
  biweekly: "Every two weeks",
  monthly: "Monthly",
  as_needed: "As needed",
};
const COVERAGE = {
  pending: "Awaiting check",
  updates: "New findings",
  no_updates: "No new findings",
  failed: "Check failed",
  partial: "Partially checked",
};

export function developmentDateNow() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(new Date());
}

function AddToAgenda({
  finding,
  onClose,
}: {
  finding: FundraisingFinding;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [date, setDate] = useState(developmentDateNow);
  const [meetingId, setMeetingId] = useState("");
  const [saving, setSaving] = useState(false);
  const meetings = useListDevelopmentMeetings();
  const upcoming = (meetings.data ?? [])
    .filter(
      (meeting) =>
        meeting.note.meetingDate.slice(0, 10) >= developmentDateNow(),
    )
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const selection = meetingId || upcoming[0]?.note.id || "new";
  async function save() {
    setSaving(true);
    try {
      const id =
        selection === "new"
          ? (await createDevelopmentMeeting({ date })).note.id
          : selection;
      await addDevelopmentAgendaItem(id, {
        findingKind: finding.kind,
        findingId: finding.id,
      });
      await queryClient.invalidateQueries({
        queryKey: getListDevelopmentMeetingsQueryKey(),
      });
      await queryClient.invalidateQueries({
        queryKey: ["/api/development-meetings/" + id],
      });
      toast({
        title: "Added to the development meeting",
        action: (
          <Button asChild variant="outline" size="sm">
            <Link href={"/meetings/development/" + id}>Open agenda</Link>
          </Button>
        ),
      });
      onClose();
    } catch (error) {
      toast({
        title: "Could not add this finding",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to development meeting</DialogTitle>
          <DialogDescription>{finding.title}</DialogDescription>
        </DialogHeader>
        {meetings.isError && (
          <p className="text-sm text-destructive">
            Upcoming meetings could not be loaded.
          </p>
        )}
        <label className="grid gap-2 text-sm">
          Meeting
          <select
            className="rounded-md border bg-background p-2"
            value={selection}
            onChange={(event) => setMeetingId(event.target.value)}
          >
            {upcoming.map((meeting) => (
              <option key={meeting.note.id} value={meeting.note.id}>
                {formatDate(meeting.note.meetingDate.slice(0, 10))}
              </option>
            ))}
            <option value="new">Choose a meeting date</option>
          </select>
        </label>
        {selection === "new" && (
          <label className="grid gap-2 text-sm">
            Date
            <Input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              saving || meetings.isLoading || (selection === "new" && !date)
            }
            onClick={() => void save()}
          >
            {saving ? "Adding…" : "Add to agenda"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FindingRow({
  finding,
  compact,
  readOnly,
}: {
  finding: FundraisingFinding;
  compact: boolean;
  readOnly: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [agendaOpen, setAgendaOpen] = useState(false);
  async function review(next: FundraisingFinding["review"]) {
    setSaving(true);
    try {
      await reviewFundraisingFinding(finding.id, {
        kind: finding.kind,
        review: next,
      });
      await queryClient.invalidateQueries({
        queryKey: getGetFundraisingBriefQueryKey(),
      });
    } catch (error) {
      toast({
        title: "Could not save review",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <article className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            finding.category === "funding_opportunity" ? "default" : "secondary"
          }
        >
          {CATEGORIES[finding.category]}
        </Badge>
        {finding.review !== "unreviewed" && (
          <Badge variant="outline">
            {finding.review === "useful" ? "Useful" : "Dismissed"}
          </Badge>
        )}
      </div>
      <div>
        <h3 className="font-medium">{finding.title}</h3>
        <div className="text-xs text-muted-foreground">
          {finding.organizationId && finding.organizationName && (
            <>
              <Link
                href={"/organizations/" + finding.organizationId}
                className="text-primary hover:underline"
              >
                {finding.organizationName}
              </Link>
              {" · "}
            </>
          )}
          {finding.source}
          {finding.publishedAt && " · " + formatDate(finding.publishedAt)}
          {finding.ownerName && " · Owner: " + finding.ownerName}
        </div>
      </div>
      {!compact && finding.summary && (
        <p className="text-sm">{finding.summary}</p>
      )}
      <p className="text-sm text-muted-foreground">
        {finding.reason}
        {finding.deadline &&
          " · Due " +
            (finding.deadline.match(/^\d{4}-\d{2}-\d{2}$/)
              ? formatDate(finding.deadline)
              : finding.deadline)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {finding.url && (
          <Button asChild variant="outline" size="sm">
            <a href={finding.url} target="_blank" rel="noreferrer">
              Public source
            </a>
          </Button>
        )}
        {finding.kind === "grant_lead" && (
          <Button asChild variant="outline" size="sm">
            <Link href={"/grant-leads?lead=" + encodeURIComponent(finding.id)}>
              Grant lead
            </Link>
          </Button>
        )}
        {!readOnly && finding.review !== "dismissed" && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAgendaOpen(true)}
            >
              Add to agenda
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                void review(
                  finding.review === "useful" ? "unreviewed" : "useful",
                )
              }
            >
              {finding.review === "useful" ? "Undo useful" : "Mark useful"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => void review("dismissed")}
            >
              Dismiss
            </Button>
          </>
        )}
        {!readOnly && finding.review === "dismissed" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void review("unreviewed")}
          >
            Restore to review
          </Button>
        )}
      </div>
      {agendaOpen && (
        <AddToAgenda finding={finding} onClose={() => setAgendaOpen(false)} />
      )}
    </article>
  );
}

export function FundraisingBriefCard() {
  const brief = useGetFundraisingBrief();
  const { data: user } = useGetCurrentUser();
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
        <CardTitle className="text-lg" role="heading" aria-level={2}>
          This week in fundraising
        </CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link href="/fundraising-brief">View findings and scan coverage</Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {brief.isLoading && (
          <p className="text-sm text-muted-foreground">
            Loading fundraising updates…
          </p>
        )}
        {brief.isError && (
          <p className="text-sm text-destructive">
            Fundraising updates could not be loaded.
          </p>
        )}
        {brief.data?.findings.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No priority findings surfaced in the last seven days.
          </p>
        )}
        {brief.data?.findings.map((finding) => (
          <FindingRow
            key={finding.kind + finding.id}
            finding={finding}
            compact
            readOnly={!user || user.role === "read_only"}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export function FundraisingBriefPage() {
  const brief = useGetFundraisingBrief({ all: true });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [funder, setFunder] = useState<PickedContact | null>(null);
  const [queueing, setQueueing] = useState(false);
  async function checkFunder() {
    if (funder?.kind !== "organization") return;
    setQueueing(true);
    try {
      await requestFunderScan(funder.id);
      setFunder(null);
      await queryClient.invalidateQueries({
        queryKey: getGetFundraisingBriefQueryKey(),
      });
      toast({
        title: "Funder check queued",
        description: "See the result in Scan coverage.",
      });
    } catch (error) {
      toast({
        title: "Could not queue funder check",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setQueueing(false);
    }
  }
  const { data: user } = useGetCurrentUser();
  const [showDismissed, setShowDismissed] = useState(false);
  const [search, setSearch] = useState("");
  const filter = search.trim().toLowerCase();
  const selectedFinding = new URLSearchParams(useSearch()).get("finding");
  const groups = new Map<string, FundraisingFinding[]>();
  for (const item of brief.data?.findings ?? []) {
    if (
      selectedFinding
        ? item.id !== selectedFinding
        : item.review === "dismissed" && !showDismissed
    )
      continue;
    if (
      filter &&
      ![item.organizationName, item.title, item.source].some((field) =>
        field?.toLowerCase().includes(filter),
      )
    )
      continue;
    const name = item.organizationName ?? "Other funders";
    const list = groups.get(name) ?? [];
    list.push(item);
    groups.set(name, list);
  }
  const coverage = (brief.data?.coverage ?? []).filter(
    (row) => !filter || row.organizationName.toLowerCase().includes(filter),
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-serif font-bold">Fundraising brief</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/email-intelligence">Email intelligence</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/meetings/development">Development meetings</Link>
          </Button>
        </div>
      </div>
      {selectedFinding && (
        <Link
          href="/fundraising-brief"
          className="text-sm text-primary hover:underline"
        >
          Show all findings
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search findings or funders"
          aria-label="Search findings or funders"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(event) => setShowDismissed(event.target.checked)}
          />{" "}
          Show dismissed
        </label>
      </div>
      {brief.isLoading && (
        <p className="text-sm text-muted-foreground">
          Loading fundraising brief…
        </p>
      )}
      {brief.isError && (
        <p className="text-sm text-destructive">
          Fundraising brief could not be loaded.
        </p>
      )}
      {brief.data && (
        <>
          <section className="space-y-4" aria-label="Findings by funder">
            {groups.size === 0 && (
              <p className="text-sm text-muted-foreground">
                No matching findings in the last 90 days.
              </p>
            )}
            {[...groups].map(([name, items]) => (
              <section className="space-y-2" key={name}>
                <h2 className="font-semibold">{name}</h2>
                {items.map((finding) => (
                  <FindingRow
                    key={finding.kind + finding.id}
                    finding={finding}
                    compact={false}
                    readOnly={!user || user.role === "read_only"}
                  />
                ))}
              </section>
            ))}
          </section>
          <details className="rounded-md border p-4">
            <summary className="cursor-pointer font-semibold">
              Scan coverage
            </summary>
            <p className="py-2 text-sm text-muted-foreground">
              Schedules follow existing opportunities, pledges, and credited
              giving.
            </p>
            {user && user.role !== "read_only" && (
              <div className="mb-3 flex flex-wrap items-start gap-2">
                <div className="w-full max-w-sm">
                  <ContactPicker
                    value={funder}
                    onChange={setFunder}
                    kinds={["organization"]}
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={queueing || !funder}
                  onClick={() => void checkFunder()}
                >
                  {queueing ? "Queueing…" : "Check public sources"}
                </Button>
              </div>
            )}
            <ul className="space-y-2">
              {coverage.map((row) => (
                <li
                  key={row.organizationId}
                  className="flex flex-wrap justify-between gap-2 border-t pt-2 text-sm"
                >
                  <div>
                    <Link
                      href={"/organizations/" + row.organizationId}
                      className="font-medium text-primary hover:underline"
                    >
                      {row.organizationName}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {CADENCE[row.cadence]} · {row.reason}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {COVERAGE[row.status]}
                    {row.findingCount > 0 &&
                      " · " + row.findingCount + " found"}
                    {row.lastAttemptAt &&
                      " · Attempted " +
                        formatDate(row.lastAttemptAt.slice(0, 10))}
                    {row.lastCheckedAt &&
                      row.lastCheckedAt !== row.lastAttemptAt &&
                      " · Last completed " +
                        formatDate(row.lastCheckedAt.slice(0, 10))}
                  </div>
                </li>
              ))}
              {coverage.length === 0 && (
                <li className="text-sm text-muted-foreground">
                  No matching funders on an automatic schedule.
                </li>
              )}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
