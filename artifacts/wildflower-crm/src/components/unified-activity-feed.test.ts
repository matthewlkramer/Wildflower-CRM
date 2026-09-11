import { describe, expect, it } from "vitest";
import type { MediaMention } from "@workspace/api-client-react";
import {
  shouldOfferAddSender,
  splitMediaMentionsByRelevance,
} from "./unified-activity-feed";

describe("activity email sender actions", () => {
  it.each([
    "matt@wildflowerschools.org",
    "staff@blackwildflowers.org",
  ])("does not offer Add sender for internal address %s", (fromEmail) => {
    expect(
      shouldOfferAddSender({
        direction: "received",
        fromEmail,
        isInternalSender: true,
      }),
    ).toBe(false);
  });

  it("offers Add sender for an external received address", () => {
    expect(
      shouldOfferAddSender({
        direction: "received",
        fromEmail: "donor@example.org",
        isInternalSender: false,
      }),
    ).toBe(true);
  });

  it("does not offer Add sender on sent messages", () => {
    expect(
      shouldOfferAddSender({
        direction: "sent",
        fromEmail: "donor@example.org",
        isInternalSender: false,
      }),
    ).toBe(false);
  });
});

describe("media relevance disclosure", () => {
  const row = (id: string, filtered: boolean, pinned = false) =>
    ({ id, filtered, pinned } as MediaMention);

  it("hides likely irrelevant rows by default", () => {
    const result = splitMediaMentionsByRelevance([
      row("visible", false),
      row("hidden", true),
    ]);
    expect(result.visible.map((item) => item.id)).toEqual(["visible"]);
    expect(result.hidden.map((item) => item.id)).toEqual(["hidden"]);
  });

  it("never hides a pinned row", () => {
    const result = splitMediaMentionsByRelevance([
      row("pinned", true, true),
    ]);
    expect(result.visible.map((item) => item.id)).toEqual(["pinned"]);
    expect(result.hidden).toEqual([]);
  });
});
