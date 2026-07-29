// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFeedbackContext } from "./feedback-capture";

const rect = {
  x: 10,
  y: 10,
  top: 10,
  left: 10,
  right: 210,
  bottom: 40,
  width: 200,
  height: 30,
  toJSON: () => ({}),
};

describe("feedback page-state capture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("captures visible filters and selected tabs while excluding sensitive controls", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect,
    );
    window.history.pushState(
      {},
      "",
      "/reconciliation/deposits?lens=needs_gift",
    );
    document.body.innerHTML = `
      <main>
        <button role="tab" data-state="active">Needs gift</button>
        <input aria-label="Search deposits" value="Erica Cantoni" />
        <input type="password" aria-label="Secret" value="do-not-capture" />
        <button aria-pressed="true">Show excluded</button>
        <div data-testid="deposit-row-bdep_123">Row</div>
      </main>
    `;

    const context = collectFeedbackContext();
    expect(context.pathname).toBe("/reconciliation/deposits");
    expect(context.search).toBe("?lens=needs_gift");
    expect(context.activeTabs).toEqual(["Needs gift"]);
    expect(context.activeControls).toContain("Show excluded");
    expect(context.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Search deposits",
          value: "Erica Cantoni",
        }),
      ]),
    );
    expect(
      context.controls.some((control) => control.value === "do-not-capture"),
    ).toBe(false);
    expect(context.visibleTestIds).toContain("deposit-row-bdep_123");
  });
});
