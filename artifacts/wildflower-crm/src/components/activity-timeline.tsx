import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useListInteractions,
  useListEmailMessages,
  useListCalendarEvents,
  type Interaction,
  type EmailMessage,
  type CalendarEvent,
  type InteractionKind,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LogInteractionDialog } from "@/components/log-interaction-dialog";
import { EmailDetailDialog } from "@/components/email-detail-dialog";
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
} from "lucide-react";

interface Props {
  personId?: string;
  funderId?: string;
  householdId?: string;
}

type Item =
  | { kind: "interaction"; at: string; row: Interaction }
  | { kind: "email"; at: string; row: EmailMessage }
  | { kind: "calendar"; at: string; row: CalendarEvent };

const INTERACTION_LABEL: Record<InteractionKind, string> = {
  meeting: "Meeting",
  phone_call: "Phone call",
  video_call: "Video call",
  conference: "Conference",
  other: "Note",
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
  // We over-fetch a little (3 sources * limit) but the alternative —
  // a unified server-side merged timeline endpoint — is more plumbing
  // than this UI warrants right now. If any single source returns
  // fewer rows than the cap, we know we've exhausted it.
  const [limit, setLimit] = useState(PAGE_SIZE);
  const filters = { personId, funderId, householdId, limit };
  const ints = useListInteractions(filters);
  const emails = useListEmailMessages(filters);
  const cals = useListCalendarEvents(filters);
  const [openEmailId, setOpenEmailId] = useState<string | null>(null);

  // Merge + sort newest-first on the client. Each source caps at limit=50,
  // so we hold at most ~150 rows in memory per detail page — plenty for the
  // UI but explicit so we don't accidentally try to render thousands.
  const items: Item[] = useMemo(() => {
    const merged: Item[] = [
      ...(ints.data?.data ?? []).map<Item>((r) => ({
        kind: "interaction", at: r.occurredAt, row: r,
      })),
      ...(emails.data?.data ?? []).map<Item>((r) => ({
        kind: "email", at: r.sentAt, row: r,
      })),
      ...(cals.data?.data ?? []).map<Item>((r) => ({
        kind: "calendar", at: r.startAt, row: r,
      })),
    ];
    merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return merged;
  }, [ints.data, emails.data, cals.data]);

  const loading = ints.isLoading || emails.isLoading || cals.isLoading;
  // "More to load" if any source is currently at its cap. The matching
  // server uses total counts, so once we've fetched everything from
  // every source the button hides itself.
  const totals = {
    int: ints.data?.pagination.total ?? 0,
    email: emails.data?.pagination.total ?? 0,
    cal: cals.data?.pagination.total ?? 0,
  };
  const hasMore =
    totals.int > limit || totals.email > limit || totals.cal > limit;

  return (
    <Card data-testid="activity-timeline">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Activity</CardTitle>
        <LogInteractionDialog
          prefillPersonId={personId}
          prefillFunderId={funderId}
          prefillHouseholdId={householdId}
          compact
        />
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Log an interaction or connect Gmail / Calendar in Settings.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((it) => {
              if (it.kind === "interaction") {
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
              if (it.kind === "email") {
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
