// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/flag-for-research-dialog", () => ({
  FlagForResearchDialog: ({
    open,
    targetType,
    targetId,
    recordLabel,
  }: {
    open: boolean;
    targetType: string;
    targetId: string;
    recordLabel: string;
  }) =>
    open ? (
      <div data-testid="flag-dialog">
        {targetType}:{targetId}:{recordLabel}
      </div>
    ) : null,
}));

import { RowActionIcons } from "./row-action-icons";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("RowActionIcons flag action", () => {
  it("opens the shared cleanup-queue dialog without triggering the row", async () => {
    const rowClick = vi.fn();
    await act(async () =>
      root.render(
        <div onClick={rowClick}>
          <RowActionIcons
            entityLabel="Example pledge"
            testIdPrefix="opp-123"
            flagForResearch={{ targetType: "pledge", targetId: "123" }}
          />
        </div>,
      ),
    );

    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="button-flag-opp-123"]',
    );
    expect(button?.getAttribute("aria-label")).toBe(
      "Flag Example pledge for research",
    );

    await act(async () => button?.click());

    expect(rowClick).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="flag-dialog"]')?.textContent).toBe(
      "pledge:123:Example pledge",
    );
  });
});
