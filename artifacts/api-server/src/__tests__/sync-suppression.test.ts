import { describe, expect, it } from "vitest";
import { shouldSuppressMeeting } from "../lib/calendarMeetingFilter";
import type { MeetingFilterConfig } from "../lib/calendarMeetingFilter";
import { isCalendarInviteMessage } from "../lib/calendarInviteDetector";
import { normalizeForMatching } from "../lib/emailMatcher";
import type { GCalEvent } from "../lib/gcal";
import type { GmailMessage } from "../lib/gmail";

// ── shouldSuppressMeeting ────────────────────────────────────────────────────

const BASE_CONFIG: MeetingFilterConfig = {
  titlePatterns: ["all hands", "staff meeting", "board meeting"],
  attendeeCountCutoff: 5,
};

function makeEvent(
  summary: string | undefined,
  attendeeCount: number,
): GCalEvent {
  return {
    id: "test-event",
    summary,
    attendees: Array.from({ length: attendeeCount }, (_, i) => ({
      email: `person${i}@example.com`,
    })),
    start: { dateTime: "2026-01-01T10:00:00Z" },
    end: { dateTime: "2026-01-01T11:00:00Z" },
    status: "confirmed",
  };
}

describe("shouldSuppressMeeting — title patterns", () => {
  it("suppresses exact match (case-insensitive)", () => {
    expect(shouldSuppressMeeting(makeEvent("All Hands Meeting", 1), BASE_CONFIG)).toBe(true);
  });

  it("suppresses substring match", () => {
    expect(shouldSuppressMeeting(makeEvent("Quarterly staff meeting recap", 1), BASE_CONFIG)).toBe(true);
  });

  it("does NOT suppress unrelated meeting", () => {
    expect(shouldSuppressMeeting(makeEvent("1:1 with Jane", 1), BASE_CONFIG)).toBe(false);
  });

  it("handles undefined summary (treated as empty string)", () => {
    expect(shouldSuppressMeeting(makeEvent(undefined, 1), BASE_CONFIG)).toBe(false);
  });

  it("ignores empty string patterns", () => {
    const cfg: MeetingFilterConfig = { titlePatterns: ["", "board meeting"], attendeeCountCutoff: null };
    expect(shouldSuppressMeeting(makeEvent("Random Event", 1), cfg)).toBe(false);
  });
});

describe("shouldSuppressMeeting — attendee cutoff", () => {
  it("suppresses when count >= cutoff", () => {
    expect(shouldSuppressMeeting(makeEvent("Team sync", 5), BASE_CONFIG)).toBe(true);
    expect(shouldSuppressMeeting(makeEvent("Team sync", 10), BASE_CONFIG)).toBe(true);
  });

  it("does NOT suppress when count < cutoff", () => {
    expect(shouldSuppressMeeting(makeEvent("Team sync", 4), BASE_CONFIG)).toBe(false);
  });

  it("handles null cutoff — count suppression disabled", () => {
    const cfg: MeetingFilterConfig = { titlePatterns: [], attendeeCountCutoff: null };
    expect(shouldSuppressMeeting(makeEvent("Anything", 100), cfg)).toBe(false);
  });

  it("handles zero cutoff — count suppression disabled", () => {
    const cfg: MeetingFilterConfig = { titlePatterns: [], attendeeCountCutoff: 0 };
    expect(shouldSuppressMeeting(makeEvent("Anything", 100), cfg)).toBe(false);
  });

  it("handles empty attendees array", () => {
    expect(shouldSuppressMeeting(makeEvent("Meeting", 0), BASE_CONFIG)).toBe(false);
  });

  it("handles undefined attendees", () => {
    const event: GCalEvent = {
      id: "e1",
      summary: "Sync",
      start: { dateTime: "2026-01-01T10:00:00Z" },
      end: { dateTime: "2026-01-01T11:00:00Z" },
      status: "confirmed",
    };
    expect(shouldSuppressMeeting(event, BASE_CONFIG)).toBe(false);
  });
});

describe("shouldSuppressMeeting — combined", () => {
  it("title match alone triggers suppression", () => {
    expect(shouldSuppressMeeting(makeEvent("Board Meeting", 2), BASE_CONFIG)).toBe(true);
  });

  it("count alone triggers suppression", () => {
    expect(shouldSuppressMeeting(makeEvent("Donor call", 5), BASE_CONFIG)).toBe(true);
  });
});

// ── isCalendarInviteMessage ──────────────────────────────────────────────────

function makeGmailMeta(subject: string, from: string): GmailMessage {
  return {
    id: "msg1",
    threadId: "t1",
    labelIds: [],
    snippet: "",
    payload: {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
      ],
      mimeType: "text/plain",
    },
    internalDate: "1234567890000",
  };
}

describe("isCalendarInviteMessage — subject prefixes", () => {
  it("detects 'Invitation:' prefix", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("Invitation: Team sync", "alice@example.com"))).toBe(true);
  });

  it("detects 'Updated invitation:' prefix", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("Updated invitation: Board Meeting", "bob@example.com"))).toBe(true);
  });

  it("detects 'Canceled:' prefix", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("Canceled: 1:1", "charlie@example.com"))).toBe(true);
  });

  it("detects 'Accepted:' prefix", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("Accepted: Lunch", "dave@example.com"))).toBe(true);
  });

  it("detects 'Declined:' prefix", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("Declined: Offsite", "eve@example.com"))).toBe(true);
  });

  it("detects 'Tentative:' prefix", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("Tentative: Site visit", "frank@example.com"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("INVITATION: Staff meeting", "g@example.com"))).toBe(true);
  });

  it("does NOT flag normal email subjects", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("Thanks for meeting!", "h@example.com"))).toBe(false);
    expect(isCalendarInviteMessage(makeGmailMeta("Re: Invitation letter draft", "h@example.com"))).toBe(false);
  });
});

describe("isCalendarInviteMessage — sender domain", () => {
  it("flags calendar-notification.google.com sender", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("", "Calendar <noreply@calendar-notification.google.com>"))).toBe(true);
  });

  it("flags calendar.google.com sender", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("", "noreply@calendar.google.com"))).toBe(true);
  });

  it("flags calendar-notification local part", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("", "calendar-notification@google.com"))).toBe(true);
  });

  it("does NOT flag regular @gmail.com senders", () => {
    expect(isCalendarInviteMessage(makeGmailMeta("", "donor@gmail.com"))).toBe(false);
  });

  it("does NOT flag arbitrary @google.com to avoid false positives", () => {
    // google.com was removed from CALENDAR_SENDER_DOMAINS to prevent
    // false-positives on legitimate Google service mail (Workspace admin
    // notifications, Google Alerts, etc.).  Only the specific calendar
    // infrastructure sub-domains are matched.
    expect(isCalendarInviteMessage(makeGmailMeta("", "someservice@google.com"))).toBe(false);
  });
});

// ── normalizeForMatching ─────────────────────────────────────────────────────

describe("normalizeForMatching", () => {
  it("lowercases addresses", () => {
    expect(normalizeForMatching(["ALICE@Example.COM"], null)).toEqual(["alice@example.com"]);
  });

  it("removes the mailbox owner address", () => {
    expect(normalizeForMatching(["alice@example.com", "bob@example.com"], "alice@example.com")).toEqual([
      "bob@example.com",
    ]);
  });

  it("strips internal @wildflowerschools.org addresses", () => {
    expect(normalizeForMatching(["staff@wildflowerschools.org", "donor@outside.org"], null)).toEqual([
      "donor@outside.org",
    ]);
  });

  it("dedupes addresses", () => {
    expect(normalizeForMatching(["x@y.com", "X@Y.com", "x@y.com"], null)).toEqual(["x@y.com"]);
  });

  it("ignores empty strings", () => {
    expect(normalizeForMatching(["", "  ", "a@b.com"], null)).toEqual(["a@b.com"]);
  });
});

// ── backfill helpers (pure-logic regression tests) ───────────────────────────

// Inline mirrors of the pure helpers in backfill-sync-suppression.ts.
// Kept here so the correctness of the key decision logic is tested
// independently of the DB-touching backfill script.

interface SuppressionWindowSpec {
  personId: string;
  startDate: Date | null;
  endDate: Date | null;
}

function windowCoversDate(w: SuppressionWindowSpec, date: Date): boolean {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  if (w.startDate) {
    const ws = new Date(w.startDate);
    ws.setUTCHours(0, 0, 0, 0);
    if (dayStart < ws) return false;
  }
  if (w.endDate) {
    const we = new Date(w.endDate);
    we.setUTCHours(0, 0, 0, 0);
    if (dayStart > we) return false;
  }
  return true;
}

function isFullyUnmatched(opts: {
  cleanedPersonIds: string[];
  funderIds: string[];
  householdIds: string[];
}): boolean {
  return (
    opts.cleanedPersonIds.length === 0 &&
    opts.funderIds.length === 0 &&
    opts.householdIds.length === 0
  );
}

/** Inline of backfill isCalendarSender. */
function isCalendarSender(fromEmail: string | null): boolean {
  const CALENDAR_SENDER_DOMAINS = new Set([
    "calendar.google.com",
    "calendar-notification.google.com",
  ]);
  const CALENDAR_SENDER_LOCALS = new Set(["calendar-notification", "noreply-calendar"]);
  if (!fromEmail) return false;
  const lower = fromEmail.toLowerCase();
  const match = lower.match(/<([^>]+)>$/);
  const addr = match ? match[1]! : lower;
  const atIdx = addr.lastIndexOf("@");
  if (atIdx === -1) return false;
  const local = addr.slice(0, atIdx);
  const domain = addr.slice(atIdx + 1);
  return CALENDAR_SENDER_DOMAINS.has(domain) || CALENDAR_SENDER_LOCALS.has(local);
}

describe("backfill — windowCoversDate", () => {
  const W: SuppressionWindowSpec = {
    personId: "p1",
    startDate: new Date("2024-03-01T00:00:00Z"),
    endDate: new Date("2024-03-31T00:00:00Z"),
  };

  it("covers a date in the middle of the window", () => {
    expect(windowCoversDate(W, new Date("2024-03-15T14:00:00Z"))).toBe(true);
  });

  it("covers the start day", () => {
    expect(windowCoversDate(W, new Date("2024-03-01T23:59:59Z"))).toBe(true);
  });

  it("covers the end day (end-date inclusive fix)", () => {
    // Key regression: a message arriving at 15:00 on the end date must still
    // be suppressed even though endDate is stored as midnight.
    expect(windowCoversDate(W, new Date("2024-03-31T15:30:00Z"))).toBe(true);
  });

  it("does not cover the day after the end date", () => {
    expect(windowCoversDate(W, new Date("2024-04-01T00:00:00Z"))).toBe(false);
  });

  it("does not cover a date before the start date", () => {
    expect(windowCoversDate(W, new Date("2024-02-28T23:59:59Z"))).toBe(false);
  });

  it("open-start window covers any date on or before end", () => {
    const w: SuppressionWindowSpec = { personId: "p1", startDate: null, endDate: new Date("2024-06-30T00:00:00Z") };
    expect(windowCoversDate(w, new Date("2020-01-01T00:00:00Z"))).toBe(true);
  });

  it("open-end window covers any date on or after start", () => {
    const w: SuppressionWindowSpec = { personId: "p1", startDate: new Date("2024-01-01T00:00:00Z"), endDate: null };
    expect(windowCoversDate(w, new Date("2030-12-31T00:00:00Z"))).toBe(true);
  });
});

describe("backfill — isFullyUnmatched (regression: funder/household match preserved)", () => {
  it("is fully unmatched when all arrays empty", () => {
    expect(isFullyUnmatched({ cleanedPersonIds: [], funderIds: [], householdIds: [] })).toBe(true);
  });

  it("is NOT fully unmatched when funder match remains", () => {
    // Regression: email matched to a suppressed person AND a funder must stay
    // in email_messages with just its person array trimmed.
    expect(isFullyUnmatched({ cleanedPersonIds: [], funderIds: ["funder-1"], householdIds: [] })).toBe(false);
  });

  it("is NOT fully unmatched when household match remains", () => {
    expect(isFullyUnmatched({ cleanedPersonIds: [], funderIds: [], householdIds: ["hh-1"] })).toBe(false);
  });

  it("is NOT fully unmatched when cleaned persons still has entries", () => {
    expect(isFullyUnmatched({ cleanedPersonIds: ["p2"], funderIds: [], householdIds: [] })).toBe(false);
  });
});

describe("backfill — isCalendarSender", () => {
  it("detects calendar.google.com sender", () => {
    expect(isCalendarSender("noreply@calendar.google.com")).toBe(true);
  });

  it("detects calendar-notification.google.com sender", () => {
    expect(isCalendarSender("Google Calendar <noreply@calendar-notification.google.com>")).toBe(true);
  });

  it("detects calendar-notification local part at arbitrary domain", () => {
    expect(isCalendarSender("calendar-notification@google.com")).toBe(true);
  });

  it("detects noreply-calendar local part", () => {
    expect(isCalendarSender("noreply-calendar@example.com")).toBe(true);
  });

  it("does NOT flag broad google.com sender", () => {
    expect(isCalendarSender("someservice@google.com")).toBe(false);
  });

  it("does NOT flag regular Gmail sender", () => {
    expect(isCalendarSender("donor@gmail.com")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isCalendarSender(null)).toBe(false);
  });
});
