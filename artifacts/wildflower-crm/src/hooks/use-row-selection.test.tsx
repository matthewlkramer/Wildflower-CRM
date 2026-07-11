// Regression tests for the Potential Duplicates blank-page bug: an effect
// that depended on the whole selection object AND called one of its setters
// (`clear()`) looped forever because `clear()` always produced a new Set —
// React aborted with "Maximum update depth exceeded", unmounting the app.
// These tests fail if either protective layer regresses:
//   1. the hook's setters must bail out (return the previous Set) on no-op
//      updates so any effect cycle reaches a fixed point, and
//   2. the returned selection object must be referentially stable across
//      renders that don't change the selection.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRowSelection } from "./use-row-selection";

// Tell React this is an act()-aware test environment.
(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

type Selection = ReturnType<typeof useRowSelection>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Render a probe that hands the latest hook value out to the test. */
function renderHook(): {
  current: () => Selection;
  rerender: () => void;
} {
  let latest: Selection | null = null;
  let bump: () => void = () => {};
  function Probe() {
    const [, setTick] = useState(0);
    bump = () => setTick((t) => t + 1);
    latest = useRowSelection();
    return null;
  }
  act(() => root.render(<Probe />));
  return {
    current: () => {
      if (!latest) throw new Error("hook not rendered");
      return latest;
    },
    rerender: () => act(() => bump()),
  };
}

describe("useRowSelection referential stability", () => {
  it("returns the same object across re-renders when the selection is unchanged", () => {
    const h = renderHook();
    const first = h.current();
    h.rerender();
    expect(h.current()).toBe(first);
  });

  it("clear() on an already-empty selection is a state no-op", () => {
    const h = renderHook();
    const before = h.current();
    act(() => before.clear());
    expect(h.current()).toBe(before);
  });

  it("removeMany() with no selected ids is a state no-op", () => {
    const h = renderHook();
    const before = h.current();
    act(() => before.removeMany(["not-selected"]));
    expect(h.current()).toBe(before);
    act(() => before.removeMany([]));
    expect(h.current()).toBe(before);
  });

  it("toggleVisible() with an empty id list is a state no-op", () => {
    const h = renderHook();
    const before = h.current();
    act(() => before.toggleVisible([]));
    expect(h.current()).toBe(before);
  });

  it("still updates state when the selection actually changes", () => {
    const h = renderHook();
    const before = h.current();
    act(() => before.toggle("a"));
    const after = h.current();
    expect(after).not.toBe(before);
    expect(after.selectedIds).toEqual(["a"]);
    act(() => after.clear());
    expect(h.current().selectedIds).toEqual([]);
  });
});

describe("update-depth loop regression (Potential Duplicates page pattern)", () => {
  it("mounting the page's exact effect pattern does not exceed max update depth", () => {
    // Replicates the crashing shape from potential-duplicates.tsx verbatim:
    // effects that depend on the whole `selection` object while calling its
    // setters. If the hook's no-op bailouts regress, React throws
    // "Maximum update depth exceeded" inside act() and this test fails.
    function PageLike({ type }: { type: string }) {
      const selection = useRowSelection();
      const visibleKeySet = new Set<string>();

      useEffect(() => {
        const stale = selection.selectedIds.filter((k) => !visibleKeySet.has(k));
        if (stale.length) selection.removeMany(stale);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selection]);

      useEffect(() => {
        selection.clear();
      }, [type, selection]);

      return <div data-testid="page">count: {selection.count}</div>;
    }

    expect(() => {
      act(() => root.render(<PageLike type="organization" />));
      act(() => root.render(<PageLike type="person" />));
    }).not.toThrow();
    expect(container.textContent).toContain("count: 0");
  });

  it("stale-prune + clear cycle reaches a fixed point even with a live selection", () => {
    function PageLike({ type }: { type: string }) {
      const selection = useRowSelection();
      useEffect(() => {
        // Everything is "stale" — prune it all, every time the selection
        // changes. Must terminate once the selection is empty.
        if (selection.selectedIds.length) {
          selection.removeMany(selection.selectedIds);
        }
      }, [selection]);
      useEffect(() => {
        selection.clear();
      }, [type, selection]);
      return <button onClick={() => selection.toggle("x")}>toggle</button>;
    }

    expect(() => {
      act(() => root.render(<PageLike type="organization" />));
      // Select a row → the prune effect fires → must settle back to empty.
      act(() => {
        container.querySelector("button")!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
    }).not.toThrow();
  });
});
