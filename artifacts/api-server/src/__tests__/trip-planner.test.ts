import { describe, expect, it } from "vitest";
import {
  looksLikeTripInvitation,
  mergedBusyMinutes,
  tripAvailability,
} from "../lib/tripPlanner";
import {
  deriveTripTravelBookings,
  detectTripTravelKind,
  extractTravelConfirmation,
} from "../lib/tripTravelBookings";
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

describe("trip travel booking derivations", () => {
  const trip = {
    travelStartsAt: new Date("2026-10-11T12:00:00.000Z"),
    travelEndsAt: new Date("2026-10-16T02:00:00.000Z"),
    destinationCity: "New York",
  };

  it("recognizes flights and hotels without treating ordinary meetings as travel", () => {
    expect(
      detectTripTravelKind({
        title: "UA 1452 · Flight to New York",
        description: null,
        location: "ORD",
        fromEmail: null,
      }),
    ).toBe("flight");
    expect(
      detectTripTravelKind({
        title: "Stay at New York Marriott Marquis",
        description: "Check-in details",
        location: "1535 Broadway",
        fromEmail: null,
      }),
    ).toBe("hotel");
    expect(
      detectTripTravelKind({
        title: "Donor meeting",
        description: "Quarterly check-in",
        location: "New York",
        fromEmail: null,
      }),
    ).toBeNull();
    expect(
      detectTripTravelKind({
        title: "Q4 2026 planning",
        description: null,
        location: "New York",
        fromEmail: null,
      }),
    ).toBeNull();
    expect(
      detectTripTravelKind({
        title: "RE: Wildflower Schools/Bridgespan Kickoff meeting",
        description:
          "I will share my arrival time once the flight is settled for our Philadelphia meeting.",
        location: null,
        fromEmail: "colleague@example.org",
      }),
    ).toBeNull();
    expect(
      detectTripTravelKind({
        title: "Wildflower Schools/Bridgespan bi-weekly check-in",
        description:
          "Let's discuss the trip, airport arrival, and meeting schedule.",
        location: "Philadelphia, PA",
        fromEmail: "colleague@example.org",
      }),
    ).toBeNull();
    expect(
      detectTripTravelKind({
        title: "Your itinerary",
        description:
          "United UA 1452. Confirmation ABC123. Departure October 11 at 3:00 PM.",
        location: null,
        fromEmail: "receipts@united.com",
      }),
    ).toBe("flight");
  });

  it("extracts common confirmation and record-locator formats", () => {
    expect(extractTravelConfirmation("Confirmation number: N2VDPI22")).toBe(
      "N2VDPI22",
    );
    expect(extractTravelConfirmation("Record locator ABC123")).toBe("ABC123");
    expect(extractTravelConfirmation("Reservation confirmed")).toBeNull();
  });

  it("derives calendar and Gmail bookings for the trip and ignores unrelated travel", () => {
    const result = deriveTripTravelBookings(trip, [
      {
        id: "cal-flight",
        source: "calendar",
        title: "Flight to New York · UA 1452",
        description: "Confirmation: ABC123",
        location: "ORD",
        startAt: "2026-10-11T15:00:00.000Z",
        endAt: "2026-10-11T17:10:00.000Z",
        htmlLink: "https://calendar.google.com/event?eid=flight",
      },
      {
        id: "gmail-hotel",
        source: "gmail",
        title: "Your New York hotel reservation",
        description:
          "Check-in October 11, 2026. Check-out October 15, 2026. Confirmation number: N2VDPI22.",
        fromEmail: "reservations@marriott.com",
        gmailMessageId: "gmail-hotel-id",
      },
      {
        id: "gmail-other",
        source: "gmail",
        title: "Your flight to Seattle",
        description: "Departure November 20, 2026. Confirmation: SEA123",
        fromEmail: "receipts@example-air.com",
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((booking) => booking.kind === "flight")).toMatchObject({
      kind: "flight",
      source: "calendar",
      confirmationNumber: "ABC123",
      startAt: "2026-10-11T15:00:00.000Z",
    });
    const hotel = result.find((booking) => booking.kind === "hotel");
    expect(hotel).toMatchObject({
      kind: "hotel",
      source: "gmail",
      provider: "Marriott",
      confirmationNumber: "N2VDPI22",
    });
    expect(hotel?.sourceUrl).toContain("gmail-hotel-id");
  });

  it("deduplicates repeated booking evidence by confirmation number", () => {
    const result = deriveTripTravelBookings(trip, [
      {
        id: "gmail-flight",
        source: "gmail",
        title: "Flight confirmation to New York",
        description: "October 11, 2026. Record locator ABC123",
        fromEmail: "receipts@united.com",
      },
      {
        id: "calendar-flight",
        source: "calendar",
        title: "Flight to New York",
        description: "Record locator ABC123",
        startAt: "2026-10-11T15:00:00.000Z",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("calendar");
  });
});
