/**
 * Thin Google Calendar v3 REST client used by the sync worker.
 * Mirrors the design of `gmail.ts` — no SDK, no token caching, just
 * fetch + small helpers. The orchestrator (`calendarSync.ts`) calls
 * these against a freshly-refreshed access token per run.
 *
 * Surface:
 *   - getPrimaryCalendarId — resolve the user's primary calendar
 *     (always "primary" today, but kept as a function in case we
 *     ever sync more than one).
 *   - listEvents — `events.list` with sync-token / page-token /
 *     timeMin support. Raises `CalendarSyncTokenGoneError` on 410.
 *   - extractAttendeeEmails — pull attendee + organizer addresses
 *     out of an event payload, lowercased + deduped.
 */

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

export class CalendarSyncTokenGoneError extends Error {
  constructor() {
    super("Calendar sync token expired; bootstrap required");
    this.name = "CalendarSyncTokenGoneError";
  }
}

async function gcalFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const r = await fetch(`${GCAL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Calendar ${r.status} ${path}: ${text.slice(0, 500)}`);
  }
  return r;
}

export async function getPrimaryCalendarId(accessToken: string): Promise<string> {
  // Per Google docs, the literal string "primary" resolves to the
  // calling user's primary calendar in every events.list URL — we
  // don't actually need to look it up. Kept as a function so the
  // orchestrator's call site reads naturally.
  return "primary";
}

export interface GCalAttendee {
  email?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
}

export interface GCalEvent {
  id: string;
  status?: string; // "confirmed" | "tentative" | "cancelled"
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GCalAttendee[];
  organizer?: { email?: string; self?: boolean };
}

export interface GCalEventsListResponse {
  items: GCalEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface ListEventsOpts {
  syncToken?: string | null;
  pageToken?: string | null;
  timeMin?: string | null; // ISO; ignored if syncToken provided
  maxResults?: number;
}

export async function listEvents(
  accessToken: string,
  calendarId: string,
  opts: ListEventsOpts,
): Promise<GCalEventsListResponse> {
  const params = new URLSearchParams();
  // singleEvents=true expands recurring masters into instances; this
  // is what makes the timeline-oriented output usable. Without it
  // we'd have to materialise instances ourselves.
  params.set("singleEvents", "true");
  // showDeleted=true is required when using syncToken (otherwise
  // Google rejects the combination) AND it's how we learn about
  // cancellations. We persist cancelled events too so the UI can
  // render "this meeting was cancelled" instead of silently
  // dropping it.
  params.set("showDeleted", "true");
  params.set("maxResults", String(opts.maxResults ?? 250));
  if (opts.syncToken) {
    params.set("syncToken", opts.syncToken);
  } else if (opts.timeMin) {
    params.set("timeMin", opts.timeMin);
    // orderBy is only allowed in non-syncToken mode.
    params.set("orderBy", "startTime");
  }
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const path = `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
  const r = await fetch(`${GCAL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.status === 410) {
    // Sync token expired — caller drops it and re-bootstraps.
    throw new CalendarSyncTokenGoneError();
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Calendar ${r.status} ${path}: ${text.slice(0, 500)}`);
  }
  const data = (await r.json()) as {
    items?: GCalEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };
  return {
    items: data.items ?? [],
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
  };
}

/**
 * Pull lowercased, deduped email addresses out of an event's
 * attendees list (plus organizer). Used as the matcher input.
 */
export function extractAttendeeEmails(event: GCalEvent): string[] {
  const out = new Set<string>();
  for (const a of event.attendees ?? []) {
    const email = a.email?.trim().toLowerCase();
    if (email) out.add(email);
  }
  const org = event.organizer?.email?.trim().toLowerCase();
  if (org) out.add(org);
  return [...out];
}

/**
 * Resolve start/end of an event into Date objects. Calendar
 * returns either a dateTime (instant) or a date (all-day). For
 * all-day events we treat the date as midnight UTC — good enough
 * for the timeline ordering use case; the UI formats per-locale
 * anyway.
 */
export function eventTimes(event: GCalEvent): { startAt: Date | null; endAt: Date | null } {
  const s = event.start?.dateTime ?? event.start?.date ?? null;
  const e = event.end?.dateTime ?? event.end?.date ?? null;
  return {
    startAt: s ? new Date(s) : null,
    endAt: e ? new Date(e) : null,
  };
}

// Silence unused-import warning during typecheck — gcalFetch is
// exported in spirit (used during early prototyping) but only
// listEvents/extractAttendeeEmails/eventTimes are needed today.
void gcalFetch;
