import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TripVisit } from "@workspace/api-client-react";
import { TripVisitActions } from "./trip-visit-actions";

const api = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: api.toast }),
}));

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement;
let root: Root;

const visit = {
  id: "visit_1",
  tripId: "trip_1",
  personId: "person_1",
  personName: "Alice Adams",
  rank: 1,
  source: "manual",
  outreachStatus: "responded",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
} as TripVisit;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.toast.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("TripVisitActions", () => {
  it("reports the Calendar time found by a confirmation refresh", async () => {
    const onConfirm = vi.fn().mockResolvedValue({
      ...visit,
      scheduledAt: "2026-10-03T15:30:00.000Z",
    });
    act(() => {
      root.render(
        <TripVisitActions
          visit={visit}
          onEdit={() => undefined}
          onConfirm={onConfirm}
          onUnavailable={() => undefined}
          unavailablePending={false}
        />,
      );
    });

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="confirm-trip-visit-visit_1"]',
        )
        ?.click(),
    );

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(api.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Visit confirmed" }),
    );
  });

  it("marks a person unavailable through the row action", () => {
    const onUnavailable = vi.fn();
    act(() => {
      root.render(
        <TripVisitActions
          visit={visit}
          onEdit={() => undefined}
          onConfirm={vi.fn()}
          onUnavailable={onUnavailable}
          unavailablePending={false}
        />,
      );
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="unavailable-trip-visit-visit_1"]',
        )
        ?.click(),
    );

    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
