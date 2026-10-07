import { useMemo } from "react";
import { Link } from "wouter";
import {
  useGetCurrentUser,
  useListCalendarEvents,
  useListGiftsAndPayments,
  type CalendarEvent,
  getListCalendarEventsQueryKey,
  getListGiftsAndPaymentsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/format";
import { useEntityFilter } from "@/lib/entity-filter-context";

export function meetingNeedsFollowUp(
  event: Pick<
    CalendarEvent,
    "status" | "hasMeetingNotes" | "hasNextSteps" | "startAt" | "endAt"
  >,
  now: number,
) {
  return (
    event.status !== "cancelled" &&
    new Date(event.endAt ?? event.startAt).getTime() < now &&
    (!event.hasMeetingNotes || !event.hasNextSteps)
  );
}

export function PastMeetingFollowUpsCard() {
  const { data: user } = useGetCurrentUser();
  const window = useMemo(() => {
    const now = Date.now();
    return {
      now,
      startAfter: new Date(now - 60 * 86400000).toISOString(),
      startBefore: new Date(now).toISOString(),
    };
  }, []);
  const params = {
    calendarUserId: user?.id,
    startAfter: window.startAfter,
    startBefore: window.startBefore,
    excludeNotesNotNeeded: true,
    crmMatchedOnly: true,
    order: "desc" as const,
    limit: 50,
  };
  const query = useListCalendarEvents(params, {
    query: {
      enabled: Boolean(user?.id),
      queryKey: getListCalendarEventsQueryKey(params),
    },
  });
  const events = (query.data?.data ?? []).filter((event) =>
    meetingNeedsFollowUp(event, window.now),
  );
  return (
    <Card data-testid="card-past-meeting-follow-ups">
      <CardHeader>
        <CardTitle className="text-lg">Past meeting follow-ups</CardTitle>
        <p className="text-xs text-muted-foreground">
          Your 50 most recent CRM meetings in the last 60 days, with missing
          notes or next steps.
        </p>
      </CardHeader>
      <CardContent>
        {!user || query.isLoading ? (
          <p>Loading meetings…</p>
        ) : query.isError ? (
          <p role="alert">Could not load meeting follow-ups.</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No missing notes or next steps in these recent meetings.
          </p>
        ) : (
          <ul className="divide-y">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <Link
                  className="text-sm text-primary hover:underline"
                  href={`/meetings/${event.id}`}
                >
                  {event.summary || "Untitled meeting"} ·{" "}
                  {formatDate(event.startAt)}
                </Link>
                <Badge variant="outline">
                  {event.hasMeetingNotes
                    ? "Next steps missing"
                    : "Notes missing"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <Link
          href="/meetings"
          className="mt-3 inline-block text-sm text-primary hover:underline"
        >
          View all meetings
        </Link>
      </CardContent>
    </Card>
  );
}

export function GiftThankYousCard() {
  const { data: user } = useGetCurrentUser();
  const { selected } = useEntityFilter();
  const params = {
    ownerUserId: user?.id ? [user.id] : undefined,
    thankYouSentAtPresence: "blank" as const,
    entityId: selected.length ? selected : undefined,
    sort: "date_desc" as const,
    limit: 10,
  };
  const query = useListGiftsAndPayments(params, {
    query: {
      enabled: Boolean(user?.id),
      queryKey: getListGiftsAndPaymentsQueryKey(params),
    },
  });
  const gifts = query.data?.data ?? [];
  return (
    <Card data-testid="card-gift-thank-yous">
      <CardHeader>
        <CardTitle className="text-lg">Gifts needing thank-yous</CardTitle>
        <p className="text-xs text-muted-foreground">
          Your ten most recent gifts without a recorded thank-you sent date.
        </p>
      </CardHeader>
      <CardContent>
        {!user || query.isLoading ? (
          <p>Loading gifts…</p>
        ) : query.isError ? (
          <p role="alert">Could not load gifts needing thank-yous.</p>
        ) : gifts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All your gifts in this scope have a recorded thank-you.
          </p>
        ) : (
          <ul className="divide-y">
            {gifts.map((gift) => (
              <li
                key={gift.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <Link
                  href={`/gifts/${gift.id}`}
                  className="text-sm text-primary hover:underline"
                >
                  {gift.name || "Untitled gift"}
                </Link>
                <span className="text-sm">{formatCurrency(gift.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
