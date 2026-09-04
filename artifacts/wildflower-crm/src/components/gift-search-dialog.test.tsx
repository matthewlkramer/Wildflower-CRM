import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GiftOrPayment } from "@workspace/api-client-react";
import { GiftSearchDialog } from "./gift-search-dialog";

const api = vi.hoisted(() => ({
  rows: [] as GiftOrPayment[],
  params: {} as Record<string, unknown>,
}));

vi.mock("@workspace/api-client-react", () => ({
  getListGiftsAndPaymentsQueryKey: () => ["gift-search-test"],
  useListGiftsAndPayments: (params: Record<string, unknown>) => {
    api.params = params;
    return {
      data: { data: api.rows },
      isFetching: false,
    };
  },
}));

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.rows = [
    {
      id: "gift_available",
      name: "Available gift",
      amount: "100.00",
      dateReceived: "2026-05-20",
      hasPaymentEvidence: false,
    } as GiftOrPayment,
    {
      id: "gift_linked",
      name: "Already owned gift",
      amount: "1600000.00",
      dateReceived: "2026-05-22",
      hasPaymentEvidence: true,
    } as GiftOrPayment,
  ];
  api.params = {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("GiftSearchDialog", () => {
  it("visually marks linked gifts but keeps them selectable for reassignment", () => {
    const onPick = vi.fn();
    act(() => {
      root.render(
        <GiftSearchDialog
          open
          onOpenChange={() => undefined}
          onPick={onPick}
        />,
      );
    });

    const linked = document.querySelector<HTMLButtonElement>(
      '[data-testid="gift-search-result-gift_linked"]',
    );
    const available = document.querySelector<HTMLButtonElement>(
      '[data-testid="gift-search-result-gift_available"]',
    );

    expect(linked?.dataset.alreadyLinked).toBe("true");
    expect(linked?.textContent).toContain(
      "Already linked — selecting will disconnect and move it",
    );
    expect(linked?.className).toContain("bg-muted/50");
    expect(linked?.disabled).toBe(false);
    expect(available?.dataset.alreadyLinked).toBe("false");
    expect(available?.textContent).not.toContain("Already linked");

    act(() => linked?.click());
    expect(onPick).toHaveBeenCalledWith(api.rows[1]);
  });

  it("uses the canonical unlinked filter without changing the gifts-page awaiting-evidence filter", () => {
    act(() => {
      root.render(
        <GiftSearchDialog
          open
          unlinkedOnly
          onOpenChange={() => undefined}
          onPick={() => undefined}
        />,
      );
    });

    expect(api.params.unlinkedToPaymentUnit).toBe(true);
    expect(api.params.awaitingEvidence).toBeUndefined();
  });
});
