import { describe, it, expect } from "vitest";
import {
  matchSentEmailTracking,
  TRACKING_MATCH_WINDOW_MS,
  type SentEmailLike,
  type TrackedAgg,
} from "../lib/emailTrackingEnrich";

const baseSent = (over: Partial<SentEmailLike>): SentEmailLike => ({
  id: "em1",
  direction: "sent",
  gmailMessageId: null,
  fromEmail: "matt@wildflowerschools.org",
  subject: "Re: Quick call?",
  sentAt: new Date("2026-06-01T18:00:00Z"),
  ...over,
});

const baseTracked = (over: Partial<TrackedAgg>): TrackedAgg => ({
  id: "te1",
  gmailMessageId: null,
  sender: "matt@wildflowerschools.org",
  subject: "re: quick call?",
  createdAt: new Date("2026-06-01T18:00:30Z"),
  totalViews: 0,
  lastView: null,
  ...over,
});

describe("matchSentEmailTracking", () => {
  it("matches by exact gmail_message_id", () => {
    const rows = [baseSent({ gmailMessageId: "g-123", subject: "anything" })];
    const tracked = [
      baseTracked({
        gmailMessageId: "g-123",
        subject: "totally different",
        sender: "someoneelse@x.com",
        totalViews: 3,
        lastView: new Date("2026-06-02T10:00:00Z"),
      }),
    ];
    const map = matchSentEmailTracking(rows, tracked);
    expect(map.get("em1")).toEqual({
      isTracked: true,
      trackingTotalViews: 3,
      trackingLastOpenedAt: new Date("2026-06-02T10:00:00Z").toISOString(),
    });
  });

  it("matches by fuzzy sender+subject within the window (legacy sends)", () => {
    const rows = [baseSent({})];
    const tracked = [baseTracked({ totalViews: 1, lastView: new Date("2026-06-01T19:00:00Z") })];
    const map = matchSentEmailTracking(rows, tracked);
    expect(map.get("em1")?.isTracked).toBe(true);
    expect(map.get("em1")?.trackingTotalViews).toBe(1);
  });

  it("is case-insensitive on sender and subject", () => {
    const rows = [
      baseSent({ fromEmail: "MATT@Wildflowerschools.ORG", subject: "  Re: Quick Call?  " }),
    ];
    const tracked = [baseTracked({ totalViews: 2 })];
    expect(matchSentEmailTracking(rows, tracked).get("em1")?.trackingTotalViews).toBe(2);
  });

  it("does not match when subject differs", () => {
    const rows = [baseSent({ subject: "A different subject" })];
    const tracked = [baseTracked({ totalViews: 5 })];
    expect(matchSentEmailTracking(rows, tracked).has("em1")).toBe(false);
  });

  it("does not fuzzy-match outside the time window", () => {
    const rows = [baseSent({ sentAt: new Date("2026-06-01T18:00:00Z") })];
    const tracked = [
      baseTracked({
        createdAt: new Date(
          new Date("2026-06-01T18:00:00Z").getTime() + TRACKING_MATCH_WINDOW_MS + 60_000,
        ),
        totalViews: 9,
      }),
    ];
    expect(matchSentEmailTracking(rows, tracked).has("em1")).toBe(false);
  });

  it("ignores received messages", () => {
    const rows = [baseSent({ direction: "received" })];
    const tracked = [baseTracked({ totalViews: 4 })];
    expect(matchSentEmailTracking(rows, tracked).has("em1")).toBe(false);
  });

  it("marks tracked-but-unopened with zero views and null lastOpenedAt", () => {
    const rows = [baseSent({})];
    const tracked = [baseTracked({ totalViews: 0, lastView: null })];
    expect(matchSentEmailTracking(rows, tracked).get("em1")).toEqual({
      isTracked: true,
      trackingTotalViews: 0,
      trackingLastOpenedAt: null,
    });
  });

  it("aggregates views across multiple fuzzy-matching tracked rows", () => {
    const rows = [baseSent({})];
    const tracked = [
      baseTracked({ id: "a", totalViews: 2, lastView: new Date("2026-06-01T20:00:00Z") }),
      baseTracked({ id: "b", totalViews: 3, lastView: new Date("2026-06-01T21:00:00Z") }),
    ];
    const got = matchSentEmailTracking(rows, tracked).get("em1");
    expect(got?.trackingTotalViews).toBe(5);
    expect(got?.trackingLastOpenedAt).toBe(new Date("2026-06-01T21:00:00Z").toISOString());
  });

  it("exact gmail-id match is authoritative — fuzzy same-subject rows never inflate it", () => {
    const rows = [baseSent({ gmailMessageId: "g-1" })];
    const tracked = [
      baseTracked({ id: "exact", gmailMessageId: "g-1", totalViews: 2, lastView: new Date("2026-06-01T20:00:00Z") }),
      // same normalized sender+subject, no gmail id — must be ignored because an exact match exists
      baseTracked({ id: "fuzzy", totalViews: 99, lastView: new Date("2026-06-01T23:00:00Z") }),
    ];
    const got = matchSentEmailTracking(rows, tracked).get("em1");
    expect(got?.trackingTotalViews).toBe(2);
    expect(got?.trackingLastOpenedAt).toBe(new Date("2026-06-01T20:00:00Z").toISOString());
  });

  it("falls back to fuzzy when the email's gmail id has no exact tracked row", () => {
    const rows = [baseSent({ gmailMessageId: "g-unmatched" })];
    const tracked = [baseTracked({ id: "fuzzy", totalViews: 7 })];
    expect(matchSentEmailTracking(rows, tracked).get("em1")?.trackingTotalViews).toBe(7);
  });

  it("returns empty map when there are no tracked rows", () => {
    expect(matchSentEmailTracking([baseSent({})], []).size).toBe(0);
  });
});
