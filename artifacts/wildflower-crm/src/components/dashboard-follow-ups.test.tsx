import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  GiftThankYousCard,
  meetingNeedsFollowUp,
  PastMeetingFollowUpsCard,
} from "./dashboard-follow-ups";
const mocks = vi.hoisted(() => ({ gifts: vi.fn(), calendar: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  getListCalendarEventsQueryKey: (params: unknown) => ["calendar", params],
  getListGiftsAndPaymentsQueryKey: (params: unknown) => ["gifts", params],
  useGetCurrentUser: () => ({ data: { id: "viewer" } }),
  useListGiftsAndPayments: mocks.gifts,
  useListCalendarEvents: mocks.calendar,
}));
vi.mock("@/lib/entity-filter-context", () => ({
  useEntityFilter: () => ({ selected: ["foundation"] }),
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("dashboard follow-up cards", () => {
  it("excludes cancelled, ongoing, and complete meetings from reminders", () => {
    const event = {
      status: "confirmed",
      startAt: "2026-10-06T12:00:00Z",
      endAt: "2026-10-06T13:00:00Z",
      hasMeetingNotes: false,
      hasNextSteps: false,
    };
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(meetingNeedsFollowUp(event, now)).toBe(true);
    expect(meetingNeedsFollowUp({ ...event, status: "cancelled" }, now)).toBe(
      false,
    );
    expect(
      meetingNeedsFollowUp({ ...event, endAt: "2026-10-07T13:00:00Z" }, now),
    ).toBe(false);
    expect(
      meetingNeedsFollowUp(
        { ...event, hasMeetingNotes: true, hasNextSteps: true },
        now,
      ),
    ).toBe(false);
  });

  it("queries only the viewer's unacknowledged gifts in the selected entity scope", async () => {
    mocks.gifts.mockReturnValue({ data: { data: [] }, isLoading: false });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<GiftThankYousCard />));
      expect(mocks.gifts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ownerUserId: ["viewer"],
          thankYouSentAtPresence: "blank",
          entityId: ["foundation"],
        }),
        expect.anything(),
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("respects meetings dismissed as not needing notes and does not mask query errors as an empty queue", async () => {
    mocks.calendar.mockReturnValue({ isError: true, isLoading: false });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<PastMeetingFollowUpsCard />));
      expect(mocks.calendar).toHaveBeenLastCalledWith(
        expect.objectContaining({
          calendarUserId: "viewer",
          excludeNotesNotNeeded: true,
          crmMatchedOnly: true,
        }),
        expect.anything(),
      );
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not load",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
});
