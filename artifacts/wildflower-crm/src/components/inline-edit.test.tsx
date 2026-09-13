import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineEditBoolean } from "./inline-edit";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(testId: string) {
  const el = document.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!el) throw new Error(`Missing control: ${testId}`);
  return el;
}

function renderEditor(value: boolean | null, allowNull = false) {
  const onSave = vi.fn();
  act(() =>
    root.render(
      <InlineEditBoolean
        label="Donor reporting required"
        display={value === null ? "Not reviewed" : String(value)}
        value={value}
        allowNull={allowNull}
        onSave={onSave}
        testIdBase="reporting"
      />,
    ),
  );
  act(() => button("button-edit-reporting").click());
  return onSave;
}

function choose(value: "true" | "false" | "null") {
  act(() =>
    button("select-reporting").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  act(() => button(`option-reporting-${value}`).click());
}

describe("explicit boolean review", () => {
  it.each([false, true])(
    "can review a historical null as %s",
    async (answer) => {
      const onSave = renderEditor(null);
      expect(button("select-reporting").textContent).toContain("Not reviewed");
      expect(button("button-save-reporting").disabled).toBe(true);
      expect(onSave).not.toHaveBeenCalled();
      choose(answer ? "true" : "false");
      expect(button("button-save-reporting").disabled).toBe(false);
      await act(async () => button("button-save-reporting").click());
      expect(onSave).toHaveBeenCalledExactlyOnceWith(answer);
    },
  );

  it.each([false, true])("does not resave an unchanged %s answer", (answer) => {
    const onSave = renderEditor(answer);
    expect(button("button-save-reporting").disabled).toBe(true);
    choose(answer ? "true" : "false");
    expect(button("button-save-reporting").disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("preserves optional fields that permit clearing", async () => {
    const onSave = renderEditor(true, true);
    choose("null");
    await act(async () => button("button-save-reporting").click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith(null);
  });
});
