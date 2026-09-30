import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddPeopleToTripDialog } from "./trip-add-people-dialog";

const api = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListPeopleQueryKey: () => ["trip-people-test"],
  useGetCurrentUser: () => ({ data: { id: "viewer_1" } }),
  useListPeople: () => ({
    data: {
      data: [
        { id: "alice", fullName: "Alice Adams", priority: "top" },
        { id: "bob", fullName: "Bob Brown", priority: "high" },
      ],
    },
    isLoading: false,
  }),
  useAddTripVisit: () => ({ mutateAsync: api.mutateAsync }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: api.toast }),
}));

vi.mock("@/lib/visibility", () => ({
  displayPersonName: (person: { fullName: string }) => person.fullName,
}));

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.mutateAsync.mockReset();
  api.mutateAsync.mockResolvedValue({});
  api.toast.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

function option(id: string) {
  return document.querySelector<HTMLButtonElement>(
    `[data-testid="trip-person-option-${id}"]`,
  );
}

describe("AddPeopleToTripDialog", () => {
  it("lets the user select and add multiple people in one submission", async () => {
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    act(() => {
      root.render(
        <AddPeopleToTripDialog
          tripId="trip_1"
          open
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />,
      );
    });

    act(() => option("alice")?.click());
    act(() => option("bob")?.click());

    expect(option("alice")?.getAttribute("aria-pressed")).toBe("true");
    expect(option("bob")?.getAttribute("aria-pressed")).toBe("true");
    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="add-trip-people-submit"]',
    );
    expect(submit?.textContent).toContain("Add 2 people");

    await act(async () => submit?.click());

    expect(api.mutateAsync.mock.calls).toEqual([
      [{ id: "trip_1", data: { personId: "alice" } }],
      [{ id: "trip_1", data: { personId: "bob" } }],
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps failed people selected after a partial submission", async () => {
    api.mutateAsync
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("already on trip"));
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    act(() => {
      root.render(
        <AddPeopleToTripDialog
          tripId="trip_1"
          open
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />,
      );
    });
    act(() => option("alice")?.click());
    act(() => option("bob")?.click());

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="add-trip-people-submit"]',
        )
        ?.click(),
    );

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(option("alice")?.getAttribute("aria-pressed")).toBe("false");
    expect(option("bob")?.getAttribute("aria-pressed")).toBe("true");
    expect(api.toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});
