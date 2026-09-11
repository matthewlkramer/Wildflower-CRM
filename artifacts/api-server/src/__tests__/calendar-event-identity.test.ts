import { describe, expect, it } from "vitest";
import { calendarEventDismissalKey } from "../lib/calendarEventSelect";

describe("calendar event physical identity", () => {
  it("shares a trimmed non-empty Google id across synced copies", () => {
    expect(
      calendarEventDismissalKey({ id: "crm-a", gcalEventId: "  google-123  " }),
    ).toBe("google-123");
    expect(
      calendarEventDismissalKey({ id: "crm-b", gcalEventId: "google-123" }),
    ).toBe("google-123");
  });

  it("never groups empty Google ids together", () => {
    expect(calendarEventDismissalKey({ id: "crm-a", gcalEventId: "" })).toBe(
      "crm:crm-a",
    );
    expect(calendarEventDismissalKey({ id: "crm-b", gcalEventId: "   " })).toBe(
      "crm:crm-b",
    );
  });
});
