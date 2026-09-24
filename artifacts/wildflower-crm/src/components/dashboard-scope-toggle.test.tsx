// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardScopeToggle } from "./dashboard-scope-toggle";

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

describe("DashboardScopeToggle", () => {
  it("shows my work and team choices and reports the selected scope", async () => {
    const onValueChange = vi.fn();
    await act(async () =>
      root.render(
        <DashboardScopeToggle
          value="mine"
          onValueChange={onValueChange}
          testId="scope-toggle"
        />,
      ),
    );

    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "My work",
      "Team",
    ]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => buttons[1]?.click());
    expect(onValueChange).toHaveBeenCalledWith("team");
  });
});
