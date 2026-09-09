type BusyEvent = {
  startAt: Date | string;
  endAt?: Date | string | null;
  transparency?: string | null;
};

function asMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** Counts the union of event overlap so simultaneous events are not double-counted. */
export function mergedBusyMinutes(
  events: BusyEvent[],
  windowStart: Date,
  windowEnd: Date,
): number {
  const start = windowStart.getTime();
  const end = windowEnd.getTime();
  const intervals = events
    .filter((event) => event.transparency !== "transparent")
    .map((event) => {
      const eventStart = Math.max(start, asMillis(event.startAt));
      const rawEnd = event.endAt
        ? asMillis(event.endAt)
        : asMillis(event.startAt);
      const eventEnd = Math.min(end, Math.max(rawEnd, eventStart));
      return [eventStart, eventEnd] as const;
    })
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let activeStart = 0;
  let activeEnd = 0;
  for (const [intervalStart, intervalEnd] of intervals) {
    if (activeEnd === 0) {
      activeStart = intervalStart;
      activeEnd = intervalEnd;
    } else if (intervalStart <= activeEnd) {
      activeEnd = Math.max(activeEnd, intervalEnd);
    } else {
      total += activeEnd - activeStart;
      activeStart = intervalStart;
      activeEnd = intervalEnd;
    }
  }
  if (activeEnd !== 0) total += activeEnd - activeStart;
  return Math.round(total / 60_000);
}

export function tripAvailability(
  trip: {
    travelStartsAt: Date;
    travelEndsAt: Date;
    meetingWindowStartsAt?: Date | null;
    meetingWindowEndsAt?: Date | null;
    outboundTravelMinutes?: number | null;
    returnTravelMinutes?: number | null;
  },
  events: BusyEvent[],
) {
  const windowStart = trip.meetingWindowStartsAt ?? trip.travelStartsAt;
  const windowEnd = trip.meetingWindowEndsAt ?? trip.travelEndsAt;
  const meetingWindowMinutes = Math.max(
    0,
    Math.round((windowEnd.getTime() - windowStart.getTime()) / 60_000),
  );
  const scheduledMinutes = mergedBusyMinutes(events, windowStart, windowEnd);
  const hasTravelTime =
    trip.outboundTravelMinutes != null || trip.returnTravelMinutes != null;
  return {
    travelMinutes: hasTravelTime
      ? (trip.outboundTravelMinutes ?? 0) + (trip.returnTravelMinutes ?? 0)
      : null,
    meetingWindowMinutes,
    scheduledMinutes,
    availableMinutes: Math.max(0, meetingWindowMinutes - scheduledMinutes),
  };
}

const DIRECT_INVITATION_LANGUAGE =
  /\b(meet|meeting|visit|coffee|breakfast|lunch|dinner|catch up)\b/i;
const SCHEDULING_LANGUAGE =
  /\b(connect|available|availability|schedule|scheduling)\b/i;

export function looksLikeTripInvitation(
  message: {
    subject?: string | null;
    snippet?: string | null;
    bodyText?: string | null;
    aiSummary?: string | null;
  },
  destinationCity?: string | null,
): boolean {
  const text = [
    message.subject,
    message.snippet,
    message.aiSummary,
    message.bodyText,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 20_000);
  if (DIRECT_INVITATION_LANGUAGE.test(text)) return true;
  const city = destinationCity?.trim();
  return (
    !!city &&
    text.toLowerCase().includes(city.toLowerCase()) &&
    SCHEDULING_LANGUAGE.test(text)
  );
}
