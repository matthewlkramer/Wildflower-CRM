import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  useListInteractions,
  useListEmailMessages,
  useListCalendarEvents,
  useListEmailProposals,
  useListMeetingNotes,
  getListEmailProposalsQueryKey,
  type Interaction,
  type EmailMessage,
  type CalendarEvent,
  type EmailProposal,
  type EmailProposalKind,
  type InteractionKind,
  type MeetingNote,
} from "@workspace/api-client-react";
import {
  AddMeetingNoteDialog,
  MeetingNoteRow,
  type MeetingContext,
} from "@/components/meeting-notes-panel";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LogInteractionDialog } from "@/components/log-interaction-dialog";
import { EmailDetailDialog } from "@/components/email-detail-dialog";
import { cn } from "@/lib/utils";
import {
  Calendar as CalendarIcon,
  Mail,
  MessageSquare,
  Phone,
  Users as UsersIcon,
  Video,
  Lock,
  Paperclip,
  ExternalLink,
  Sparkles,
} from "lucide-react";

interface Props {
  personId?: string;
  funderId?: string;
  householdId?: string;
}

// Discriminated union of every event we can put on the timeline. `source`
// drives both the filter chips and the per-source counter; `at` is the
// timestamp used for the merged sort.
type Item =
  | { source: "interaction"; at: string; row: Interaction }
  | { source: "email"; at: string; row: EmailMessage }
  | { source: "calendar"; at: string; row: CalendarEvent }
  | { source: "intel"; at: string; row: EmailProposal }
  | { source: "meeting"; at: string; row: MeetingNote };

type Source = Item["source"];

const SOURCE_LABEL: Record<Source, string> = {
  interaction: "Notes",
  email: "Email",
  calendar: "Calendar",
  intel: "Intel",
  meeting: "Meetings",
};

const INTERACTION_LABEL: Record<InteractionKind, string> = {
  meeting: "Meeting",
  phone_call: "Phone call",
  video_call: "Video call",
  conference: "Conference",
  other: "Note",
};

const PROPOSAL_KIND_LABEL: Record<EmailProposalKind, string> = {
  linkedin_job_change: "LinkedIn job change",
  bounce_invalid: "Hard bounce",
  bounce_soft: "Soft bounce",
  auto_responder_move: "Auto-responder · moved",
  signature_update: "Signature drift",
  grant_opportunity: "Grant opportunity",
};

function InteractionIcon({ kind }: { kind: InteractionKind }) {
  const cls = "h-4 w-4";
  switch (kind) {
    case "phone_call": return <Phone className={cls} />;
    case "video_call": return <Video className={cls} />;
    case "conference": return <UsersIcon className={cls} />;
    case "meeting": return <UsersIcon className={cls} />;
    default: return <MessageSquare className={cls} />;
  }
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const PAGE_SIZE = 50;

export function ActivityTimeline({ personId, funderId, householdId }: Props) {
  // Per-source limit grows by PAGE_SIZE on each "Load more" click.
  // We over-fetch (4 sources * limit) but the alternative — a unified
  // server-side merged endpoint — is more plumbing than this UI warrants
  // today. If a source returns fewer rows than the cap, we know it's
  // exhausted.
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Source filter — `null` means show everything. Implemented as chips
  // above the feed (the "tabs above" pattern from the roadmap).
  const [activeSource, setActiveSource] = useState<Source | null>(null);

  const filters = { personId, funderId, householdId, limit };
  const ints = useListInteractions(filters);
  const emails = useListEmailMessages(filters);
  const cals = useListCalendarEvents(filters);
  const meetings = useListMeetingNotes(filters);

  // Email proposals are targeted at a single person or funder — they
  // don't have a household linkage in the schema, so we only fetch them
  // when scoped to a person or funder. Skipped queries are gated via
  // `enabled` so we don't waste a request returning the caller's
  // entire proposal queue.
  const proposalsEnabled = !!(personId || funderId);
  const proposalParams = { personId, funderId, limit, status: "pending" as const };
  const proposals = useListEmailProposals(proposalParams, {
    query: {
      enabled: proposalsEnabled,
      queryKey: getListEmailProposalsQueryKey(proposalParams),
    },
  });

  const [openEmailId, setOpenEmailId] = useState<string | null>(null);

  // Merge + sort newest-first on the client. Each source caps at limit,
  // so we hold at most ~200 rows in memory per detail page — plenty for
  // the UI but explicit so we don't accidentally try to render thousands.
  const allItems: Item[] = useMemo(() => {
    const merged: Item[] = [
      ...(ints.data?.data ?? []).map<Item>((r) => ({
        source: "interaction", at: r.occurredAt, row: r,
      })),
      ...(emails.data?.data ?? []).map<Item>((r) => ({
        source: "email", at: r.sentAt, row: r,
      })),
      ...(cals.data?.data ?? []).map<Item>((r) => ({
        source: "calendar", at: r.startAt, row: r,
      })),
      ...(proposals.data?.data ?? []).map<Item>((r) => ({
        source: "intel", at: r.createdAt, row: r,
      })),
      ...(meetings.data?.data ?? []).map<Item>((r) => ({
        source: "meeting", at: r.meetingDate, row: r,
      })),
    ];
    merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return merged;
  }, [ints.data, emails.data, cals.data, proposals.data, meetings.data]);

  const items = useMemo(
    () => (activeSource ? allItems.filter((it) => it.source === activeSource) : allItems),
    [allItems, activeSource],
  );

  const loading =
    ints.isLoading ||
    emails.isLoading ||
    cals.isLoading ||
    meetings.isLoading ||
    (proposalsEnabled && proposals.isLoading);

  // Per-source counts for the chip badges, computed from totals where
  // available (server-reported) so the chip reflects the true count, not
  // the currently-loaded page size.
  const counts = useMemo(() => {
    const c: Record<Source, number> = {
      interaction: ints.data?.pagination.total ?? 0,
      email: emails.data?.pagination.total ?? 0,
      calendar: cals.data?.pagination.total ?? 0,
      intel: proposalsEnabled ? (proposals.data?.pagination.total ?? 0) : 0,
      meeting: meetings.data?.pagination.total ?? 0,
    };
    return c;
  }, [ints.data, emails.data, cals.data, proposals.data, proposalsEnabled, meetings.data]);

  const totalAll =
    counts.interaction +
    counts.email +
    counts.calendar +
    counts.intel +
    counts.meeting;

  // "More to load" if any *visible* source is currently at its cap.
  // When a filter is active we only need to grow that one source.
  const hasMore = (() => {
    const overCap = (n: number) => n > limit;
    if (activeSource === "interaction") return overCap(counts.interaction);
    if (activeSource === "email") return overCap(counts.email);
    if (activeSource === "calendar") return overCap(counts.calendar);
    if (activeSource === "intel") return overCap(counts.intel);
    if (activeSource === "meeting") return overCap(counts.meeting);
    return (
      overCap(counts.interaction) ||
      overCap(counts.email) ||
      overCap(counts.calendar) ||
      overCap(counts.meeting) ||
      (proposalsEnabled && overCap(counts.intel))
    );
  })();

  const chips: { key: Source | "all"; label: string; count: number }[] = [
    { key: "all", label: "All", count: totalAll },
    { key: "interaction", label: SOURCE_LABEL.interaction, count: counts.interaction },
    { key: "email", label: SOURCE_LABEL.email, count: counts.email },
    { key: "calendar", label: SOURCE_LABEL.calendar, count: counts.calendar },
    { key: "meeting", label: SOURCE_LABEL.meeting, count: counts.meeting },
    ...(proposalsEnabled
      ? [{ key: "intel" as const, label: SOURCE_LABEL.intel, count: counts.intel }]
      : []),
  ];

  return (
    <Card data-testid="activity-timeline">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Activity</CardTitle>
        <div className="flex items-center gap-2">
          <AddMeetingNoteDialog
            ctx={{ personId, funderId, householdId } as MeetingContext}
          />
          <LogInteractionDialog
            prefillPersonId={personId}
            prefillFunderId={funderId}
            prefillHouseholdId={householdId}
            compact
          />
        </div>
      </CardHeader>
      <CardContent>
        {/* Source filter chips. Clicking re-selects the active filter or
            clears back to All. Per-chip count badge mirrors HubSpot's
            "tabs above the feed" pattern from the roadmap. */}
        <div className="flex flex-wrap gap-2 pb-3" data-testid="activity-source-chips">
          {chips.map((c) => {
            const isActive = (c.key === "all" && activeSource === null) || c.key === activeSource;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setActiveSource(c.key === "all" ? null : (c.key as Source))}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
                data-testid={`activity-source-${c.key}`}
                data-active={isActive ? "true" : "false"}
              >
                <span>{c.label}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] tabular-nums",
                    isActive ? "bg-primary-foreground/20" : "bg-muted",
                  )}
                >
                  {c.count}
                </span>
              </button>
            );
          })}
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {activeSource
              ? `No ${SOURCE_LABEL[activeSource].toLowerCase()} on this record yet.`
              : "No activity yet. Log an interaction or connect Gmail / Calendar in Settings."}
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((it) => {
              if (it.source === "interaction") {
                const r = it.row;
                return (
                  <li
                    key={`int-${r.id}`}
                    className="border rounded-md p-3 text-sm space-y-1"
                    data-testid={`activity-interaction-${r.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <InteractionIcon kind={r.kind} />
                      <Badge variant="secondary">{INTERACTION_LABEL[r.kind]}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtWhen(r.occurredAt)}</span>
                      {r.durationMinutes ? (
                        <span className="text-xs text-muted-foreground">· {r.durationMinutes} min</span>
                      ) : null}
                    </div>
                    <div className="font-medium">{r.summary}</div>
                    {r.location ? (
                      <div className="text-xs text-muted-foreground">{r.location}</div>
                    ) : null}
                    {r.notes ? (
                      <p className="whitespace-pre-wrap text-muted-foreground">{r.notes}</p>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "email") {
                const r = it.row;
                return (
                  <li
                    key={`email-${r.id}`}
                    className="border rounded-md p-3 text-sm space-y-1 hover:bg-muted/40 cursor-pointer"
                    data-testid={`activity-email-${r.id}`}
                    onClick={() => setOpenEmailId(r.id)}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Mail className="h-4 w-4" />
                      <Badge variant="outline">Email · {r.direction}</Badge>
                      {r.isPrivate ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" /> Private
                        </Badge>
                      ) : null}
                      {r.hasAttachments ? <Paperclip className="h-3 w-3 text-muted-foreground" /> : null}
                      <span className="text-xs text-muted-foreground">{fmtWhen(r.sentAt)}</span>
                    </div>
                    <div className="font-medium truncate">{r.subject ?? "(no subject)"}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.fromEmail ?? "(unknown)"}
                      {r.toEmails?.length ? ` → ${r.toEmails.join(", ")}` : ""}
                    </div>
                    {r.snippet ? (
                      <p className="text-muted-foreground text-sm line-clamp-2">{r.snippet}</p>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "calendar") {
                const r = it.row;
                return (
                  <li
                    key={`cal-${r.id}`}
                    className="border rounded-md p-3 text-sm space-y-1"
                    data-testid={`activity-calendar-${r.id}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <CalendarIcon className="h-4 w-4" />
                      <Badge variant="outline">Calendar</Badge>
                      {r.isPrivate ? (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" /> Private
                        </Badge>
                      ) : null}
                      {r.status === "cancelled" ? (
                        <Badge variant="destructive">Cancelled</Badge>
                      ) : null}
                      <span className="text-xs text-muted-foreground">{fmtWhen(r.startAt)}</span>
                      {r.htmlLink ? (
                        <a
                          href={r.htmlLink}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto inline-flex items-center gap-1 text-xs hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Open <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                    <div className="font-medium">{r.summary ?? "(no title)"}</div>
                    {r.location ? (
                      <div className="text-xs text-muted-foreground">{r.location}</div>
                    ) : null}
                    {r.attendeeEmails?.length ? (
                      <div className="text-xs text-muted-foreground truncate">
                        {r.attendeeEmails.join(", ")}
                      </div>
                    ) : null}
                    {r.description ? (
                      <p className="text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                        {r.description}
                      </p>
                    ) : null}
                  </li>
                );
              }
              if (it.source === "meeting") {
                // Render the same row component the standalone panel
                // uses, so edit/delete/promote behavior is identical
                // whether the user opens it from the timeline or the
                // legacy panel.
                return <MeetingNoteRow key={`mtg-${it.row.id}`} note={it.row} />;
              }
              // source === "intel" — email-intelligence proposal. We
              // show a compact card with a "Review" link into the
              // email-intelligence queue rather than letting the user
              // accept/reject inline — the queue page has the full
              // payload + proposed actions context, this is just a
              // surfacing in the relationship's timeline.
              const r = it.row;
              return (
                <li
                  key={`intel-${r.id}`}
                  className="border rounded-md p-3 text-sm space-y-1 bg-amber-50/40 dark:bg-amber-950/10"
                  data-testid={`activity-proposal-${r.id}`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <Sparkles className="h-4 w-4 text-amber-600" />
                    <Badge variant="outline">
                      {PROPOSAL_KIND_LABEL[r.kind] ?? r.kind}
                    </Badge>
                    <Badge variant="secondary">Pending review</Badge>
                    <span className="text-xs text-muted-foreground">{fmtWhen(r.createdAt)}</span>
                    <Link
                      href="/email-intelligence"
                      className="ml-auto inline-flex items-center gap-1 text-xs hover:underline"
                    >
                      Review <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  {r.subjectName || r.subjectEmail ? (
                    <div className="font-medium truncate">
                      {r.subjectName ?? r.subjectEmail}
                    </div>
                  ) : null}
                  {r.subjectEmail && r.subjectName ? (
                    <div className="text-xs text-muted-foreground truncate">
                      {r.subjectEmail}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {hasMore ? (
          <div className="pt-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              data-testid="activity-load-more"
            >
              Load more
            </Button>
          </div>
        ) : null}
      </CardContent>
      <EmailDetailDialog
        emailId={openEmailId}
        onClose={() => setOpenEmailId(null)}
      />
    </Card>
  );
}
