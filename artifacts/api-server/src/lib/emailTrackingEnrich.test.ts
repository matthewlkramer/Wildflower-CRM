import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ db: {} }));

import {
  matchSentEmailTracking,
  type SentEmailLike,
  type TrackedAgg,
} from "./emailTrackingEnrich";

describe("gateway tracking attribution", () => {
  it("combines recipients for the exact sent message without leaking opens to a near duplicate", () => {
    const base: SentEmailLike = {
      id: "sent-one",
      direction: "sent",
      gmailMessageId: "gmail-one",
      fromEmail: "sender@example.test",
      subject: "Grant follow-up",
      sentAt: "2026-11-12T12:00:00Z",
    };
    const tracked: TrackedAgg = {
      id: "gateway-delivery:first",
      gmailMessageId: "gmail-one",
      sender: "sender@example.test",
      subject: "grant follow-up",
      createdAt: base.sentAt,
      totalViews: 2,
      lastView: "2026-11-12T12:06:00Z",
    };
    const matches = matchSentEmailTracking(
      [
        base,
        { ...base, id: "sent-two", gmailMessageId: "gmail-two" },
        { ...base, id: "other-mailbox", fromEmail: "other@example.test" },
      ],
      [tracked, { ...tracked, id: "gateway-delivery:second", totalViews: 1 }],
    );
    expect([...matches.keys()]).toEqual([base.id]);
    expect(matches.get(base.id)).toMatchObject({ trackingTotalViews: 3 });
  });
});
