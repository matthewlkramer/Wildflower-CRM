import { describe, expect, it } from "vitest";
import {
  looksLikeTripInvitation,
  mergedBusyMinutes,
  tripAvailability,
} from "../lib/tripPlanner";
import {
  eventOverlapsTripWindows,
  mergeTripWindows,
  shouldAutoPrivateCalendarEvent,
} from "../lib/tripCalendarWindows";

describe("trip planner derivations", () => {
  it("merges overlapping trip windows before calendar fetches", () => {
    expect(
      mergeTripWindows([
        {
          startAt: new Date("2026-10-02T12:00:00.000Z"),
          endAt: new Date("2026-10-02T18:00:00.000Z"),
        },
        {
          startAt: new Date("2026-10-01T12:00:00.000Z"),
          endAt: new Date("2026-10-02T14:00:00.000Z"),
        },
      ]),
    ).toEqual([
      {
        startAt: new Date("2026-10-01T12:00:00.000Z"),
        endAt: new Date("2026-10-02T18:00:00.000Z"),
      },
    ]);
  });

  it("captures events that overlap either edge of a trip", () => {
    const windows = [
      {
        startAt: new Date("2026-10-01T12:00:00.000Z"),
        endAt: new Date("2026-10-01T18:00:00.000Z"),
      },
    ];
    expect(
      eventOverlapsTripWindows(
        new Date("2026-10-01T11:30:00.000Z"),
        new Date("2026-10-01T12:30:00.000Z"),
        windows,
      ),
    ).toBe(true);
    expect(
      eventOverlapsTripWindows(
        new Date("2026-10-01T18:00:00.000Z"),
        new Date("2026-10-01T19:00:00.000Z"),
        windows,
      ),
    ).toBe(false);
  });

  it("defaults unmatched and Google-private trip events to private", () => {
    expect(shouldAutoPrivateCalendarEvent(false, "default")).toBe(true);
    expect(shouldAutoPrivateCalendarEvent(true, "private")).toBe(true);
    expect(shouldAutoPrivateCalendarEvent(true, "default")).toBe(false);
  });

  it("counts overlapping calendar events only once", () => {
    const start = new Date("2026-10-01T13:00:00.000Z");
    const end = new Date("2026-10-01T18:00:00.000Z");
    expect(
      mergedBusyMinutes(
        [
          {
            startAt: "2026-10-01T14:00:00.000Z",
            endAt: "2026-10-01T16:00:00.000Z",
          },
          {
            startAt: "2026-10-01T15:00:00.000Z",
            endAt: "2026-10-01T17:00:00.000Z",
          },
        ],
        start,
        end,
      ),
    ).toBe(180);
  });

  it("keeps transparent calendar events visible without treating them as busy", () => {
    expect(
      mergedBusyMinutes(
        [
          {
            startAt: "2026-10-01T14:00:00.000Z",
            endAt: "2026-10-01T16:00:00.000Z",
            transparency: "transparent",
          },
        ],
        new Date("2026-10-01T13:00:00.000Z"),
        new Date("2026-10-01T18:00:00.000Z"),
      ),
    ).toBe(0);
  });

  it("derives travel and available minutes from one shared window", () => {
    expect(
      tripAvailability(
        {
          travelStartsAt: new Date("2026-10-01T12:00:00.000Z"),
          travelEndsAt: new Date("2026-10-01T22:00:00.000Z"),
          meetingWindowStartsAt: new Date("2026-10-01T14:00:00.000Z"),
          meetingWindowEndsAt: new Date("2026-10-01T20:00:00.000Z"),
          outboundTravelMinutes: 90,
          returnTravelMinutes: 75,
        },
        [
          {
            startAt: "2026-10-01T15:00:00.000Z",
            endAt: "2026-10-01T16:30:00.000Z",
          },
        ],
      ),
    ).toEqual({
      travelMinutes: 165,
      meetingWindowMinutes: 360,
      scheduledMinutes: 90,
      availableMinutes: 270,
    });
  });

  it("recognizes meeting language but not unrelated correspondence", () => {
    expect(
      looksLikeTripInvitation(
        { subject: "Coffee while I am in Boston?" },
        "Boston",
      ),
    ).toBe(true);
    expect(
      looksLikeTripInvitation({ subject: "Quarterly grant report" }, "Boston"),
    ).toBe(false);
    expect(
      looksLikeTripInvitation({ subject: "I am available next week" }),
    ).toBe(false);
    expect(
      looksLikeTripInvitation(
        { subject: "Availability while you are in Boston" },
        "Boston",
      ),
    ).toBe(true);
  });
});
