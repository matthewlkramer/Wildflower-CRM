import { describe, expect, it } from "vitest";
import { buildTripData, type TripFormState } from "./trip-planner";

describe("trip planner form", () => {
  it("stores one availability window and clears legacy timing fields", () => {
    const form: TripFormState = {
      travelerUserId: "user_1",
      title: "  Philadelphia visit  ",
      destinationCity: " Philadelphia ",
      destinationState: " PA ",
      availableStartsAt: "2026-10-01T13:00:00.000Z",
      availableEndsAt: "2026-10-01T20:00:00.000Z",
      notes: "  Priority meetings  ",
    };

    expect(buildTripData(form)).toEqual({
      travelerUserId: "user_1",
      title: "Philadelphia visit",
      destinationCity: "Philadelphia",
      destinationState: "PA",
      travelStartsAt: "2026-10-01T13:00:00.000Z",
      travelEndsAt: "2026-10-01T20:00:00.000Z",
      meetingWindowStartsAt: null,
      meetingWindowEndsAt: null,
      outboundTravelMinutes: null,
      returnTravelMinutes: null,
      notes: "Priority meetings",
    });
  });
});
