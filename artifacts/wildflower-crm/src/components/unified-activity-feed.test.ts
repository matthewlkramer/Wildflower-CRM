import { describe, expect, it } from "vitest";
import { shouldOfferAddSender } from "./unified-activity-feed";

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
