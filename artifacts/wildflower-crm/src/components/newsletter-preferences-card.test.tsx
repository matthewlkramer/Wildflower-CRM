import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewsletterPreferencesCard } from "./newsletter-preferences-card";

const api = vi.hoisted(() => ({
  role: "team_member",
  failed: false,
  data: {
    newsletter: true,
    unsubscribedToNewsletter: true,
    data: [] as Record<string, unknown>[],
  },
  save: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: api.invalidate }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useListNewsletterPreferences: () => ({
    data: api.data,
    isLoading: false,
    isError: api.failed,
    refetch: vi.fn(),
  }),
  useGetCurrentUser: () => ({ data: { role: api.role } }),
  useCreateNewsletterPreferenceEvent: () => ({
    mutateAsync: api.save,
    isPending: false,
  }),
  getListNewsletterPreferencesQueryKey: () => ["history"],
  getGetPersonQueryKey: () => ["person"],
  getListPeopleQueryKey: () => ["people"],
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.role = "team_member";
  api.failed = false;
  api.save.mockReset();
  api.invalidate.mockReset();
  api.data = {
    newsletter: true,
    unsubscribedToNewsletter: true,
    data: [
      {
        id: "old",
        eventType: "consent_given",
        occurredAt: null,
        source: "Fillout",
        evidence: "Original Yes answer",
        recordedAt: "2026-01-01T12:00:00Z",
      },
    ],
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render() {
  act(() =>
    root.render(<NewsletterPreferencesCard personId="person_fixture" />),
  );
}
function button(text: string) {
  return [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  )!;
}
describe("newsletter preference evidence form", () => {
  it("shows suppression even with affirmative consent history, and preserves unknown event dates", () => {
    render();
    expect(
      container.querySelector('[data-testid="newsletter-current-status"]')
        ?.textContent,
    ).toBe("Opted out");
    expect(container.textContent).toContain("Event date unknown");
    expect(container.textContent).toContain(
      "Affirmative consent: evidence recorded",
    );
  });
  it("shows a load error rather than an empty preference history", () => {
    api.failed = true;
    render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be loaded",
    );
    expect(container.textContent).not.toContain("No preference evidence");
  });
  it("hides editing from read-only viewers", () => {
    api.role = "read_only";
    render();
    expect(container.textContent).not.toContain("Record preference evidence");
  });
  it("keeps a failed save open and retries the same logical event", async () => {
    api.save
      .mockRejectedValueOnce(new Error("Network interrupted"))
      .mockResolvedValueOnce({ id: "new" });
    render();
    act(() => button("Record preference evidence").click());
    // Dispatch form submission directly to exercise async/retry handling.
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Network interrupted",
    );
    const requestId = api.save.mock.calls[0][0].data.requestId;
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(api.save.mock.calls[1][0].data.requestId).toBe(requestId);
    expect(container.querySelector("form")).toBeNull();
    expect(api.invalidate).toHaveBeenCalledTimes(3);
  });
});
