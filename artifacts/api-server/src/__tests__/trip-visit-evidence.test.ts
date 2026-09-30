import { describe, expect, it } from "vitest";
import { parseTripVisitEvidenceReview } from "../lib/tripVisitEvidenceReview";

describe("trip visit evidence review", () => {
  it("accepts a supported confirmed time", () => {
    expect(
      parseTripVisitEvidenceReview({
        status: "confirmed",
        summary: "A calendar event confirms breakfast.",
        confirmedTime: "October 6 at 8:00 AM",
        confirmedAt: "2026-10-06T13:00:00.000Z",
      }),
    ).toEqual({
      status: "confirmed",
      summary: "A calendar event confirms breakfast.",
      confirmedTime: "October 6 at 8:00 AM",
      confirmedAt: "2026-10-06T13:00:00.000Z",
    });
  });

  it("does not call a reply confirmed when no time was found", () => {
    expect(
      parseTripVisitEvidenceReview({
        status: "confirmed",
        summary: "They agreed to meet but did not choose a time.",
      }),
    ).toEqual({
      status: "responded",
      summary: "They agreed to meet but did not choose a time.",
      confirmedTime: null,
      confirmedAt: null,
    });
  });

  it("accepts a permanent invitation bounce", () => {
    expect(
      parseTripVisitEvidenceReview({
        status: "bounced",
        summary:
          "The invitation failed with a permanent invalid-recipient error.",
      }),
    ).toEqual({
      status: "bounced",
      summary:
        "The invitation failed with a permanent invalid-recipient error.",
      confirmedTime: null,
      confirmedAt: null,
    });
  });
});
