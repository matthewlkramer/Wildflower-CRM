import { describe, expect, it } from "vitest";
import type {
  TripPlanDetail,
  TripPlanSummary,
} from "@workspace/api-client-react";
import {
  buildTripData,
  filterTripsByTraveler,
  getTripCalendarDisplay,
  groupTripTravelBookings,
  isBirthdayCalendarEvent,
  tripCalendarEventKey,
  type TripFormState,
} from "./trip-planner";

describe("trip planner form", () => {
  it("stores one availability window and clears legacy timing fields", () => {
    const form: TripFormState = {
      travelerUserId: "user_1",
      title: "  Philadelphia visit  ",
      destinationCity: " Philadelphia ",
      destinationState: " PA ",
      timeZone: "America/New_York",
      availableStartsAt: "2026-10-01T13:00:00.000Z",
      availableEndsAt: "2026-10-01T20:00:00.000Z",
      notes: "  Priority meetings  ",
    };

    expect(buildTripData(form)).toEqual({
      travelerUserId: "user_1",
      title: "Philadelphia visit",
      destinationCity: "Philadelphia",
      destinationState: "PA",
      timeZone: "America/New_York",
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

describe("trip planner calendar display", () => {
  const event = (
    id: string,
    summary: string,
    overrides: Partial<{
      status: string | null;
      description: string | null;
      gcalCalendarId: string;
      gcalEventId: string;
    }> = {},
  ) => ({
    id,
    summary,
    status: "confirmed",
    description: null,
    gcalCalendarId: "primary",
    gcalEventId: id,
    ...overrides,
  });

  it("recognizes birthday events from their calendar or text", () => {
    expect(
      isBirthdayCalendarEvent(
        event("calendar", "Alex", {
          gcalCalendarId: "addressbook#contacts@group.v.calendar.google.com",
        }),
      ),
    ).toBe(true);
    expect(isBirthdayCalendarEvent(event("summary", "Alex's Birthday"))).toBe(
      true,
    );
    expect(isBirthdayCalendarEvent(event("meeting", "Lunch with Alex"))).toBe(
      false,
    );
  });

  it("hides birthdays and manually hidden events but can reveal them", () => {
    const events = [
      event("visible", "Donor meeting"),
      event("manual", "Internal hold"),
      event("birthday", "Alex's birthday"),
      event("cancelled", "Cancelled meeting", { status: "cancelled" }),
    ];

    const hidden = getTripCalendarDisplay(
      events,
      [tripCalendarEventKey(events[1])],
      false,
    );
    expect(hidden.hiddenCount).toBe(2);
    expect(hidden.events.map(({ event: item }) => item.id)).toEqual([
      "visible",
    ]);

    const revealed = getTripCalendarDisplay(
      events,
      [tripCalendarEventKey(events[1])],
      true,
    );
    expect(revealed.events.map(({ event: item }) => item.id)).toEqual([
      "visible",
      "manual",
      "birthday",
    ]);
  });

  it("keeps a hidden event hidden if the database row ID changes on refresh", () => {
    const original = event("row-1", "Internal hold", {
      gcalEventId: "google-event-1",
    });
    const refreshed = event("row-2", "Internal hold", {
      gcalEventId: "google-event-1",
    });
    expect(
      getTripCalendarDisplay(
        [refreshed],
        [tripCalendarEventKey(original)],
        false,
      ).events,
    ).toEqual([]);
  });
});

describe("trip planner list", () => {
  it("filters trips to one traveler while preserving the all view", () => {
    const trips = [
      { id: "trip_1", travelerUserId: "user_1" },
      { id: "trip_2", travelerUserId: "user_2" },
      { id: "trip_3", travelerUserId: "user_1" },
    ] as TripPlanSummary[];

    expect(filterTripsByTraveler(trips, "all").map((trip) => trip.id)).toEqual([
      "trip_1",
      "trip_2",
      "trip_3",
    ]);
    expect(
      filterTripsByTraveler(trips, "user_1").map((trip) => trip.id),
    ).toEqual(["trip_1", "trip_3"]);
  });
});

describe("trip travel booking summary", () => {
  it("separates flight and hotel evidence for the summary states", () => {
    const bookings = [
      {
        kind: "flight",
        source: "calendar",
        sourceId: "flight_1",
        title: "UA 1452 to New York",
      },
      {
        kind: "hotel",
        source: "gmail",
        sourceId: "hotel_1",
        title: "New York Marriott Marquis",
      },
    ] as TripPlanDetail["travelBookings"];

    expect(groupTripTravelBookings(bookings)).toEqual({
      flights: [bookings[0]],
      hotels: [bookings[1]],
    });
    expect(groupTripTravelBookings([])).toEqual({ flights: [], hotels: [] });
  });
});
