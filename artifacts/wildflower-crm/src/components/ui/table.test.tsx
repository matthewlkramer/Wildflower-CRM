import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

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

function renderTable(header: React.ReactNode = "Name") {
  act(() => {
    root.render(
      <Table aria-label="People">
        <TableHeader>
          <TableRow>
            <TableHead>{header}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Arthur Rock</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
  });
}

function rectWithWidth(width: number): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

describe("resizable Table", () => {
  it("resizes a column with its header handle", () => {
    renderTable();
    const header = container.querySelector("th")!;
    header.getBoundingClientRect = () => rectWithWidth(120);
    const handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize Name column"]',
    )!;

    act(() => {
      handle.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 120,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 190 }),
      );
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });

    expect(header.style.width).toBe("190px");
    expect(header.style.minWidth).toBe("190px");
    expect(header.style.maxWidth).toBe("190px");
  });

  it("supports keyboard resizing and double-click reset", () => {
    renderTable();
    const header = container.querySelector("th")!;
    header.getBoundingClientRect = () => rectWithWidth(120);
    const handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize Name column"]',
    )!;

    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
    });
    expect(header.style.width).toBe("144px");

    act(() => {
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(header.style.width).toBe("");
  });

  it("does not put a column handle on grouped headers", () => {
    act(() => {
      root.render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead colSpan={2}>Funding</TableHead>
            </TableRow>
          </TableHeader>
        </Table>,
      );
    });

    expect(
      container.querySelector('[aria-label="Resize Funding column"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Resize table width"]'),
    ).not.toBeNull();
  });

  it("resizes the whole table frame horizontally", () => {
    renderTable();
    const frame = container.querySelector<HTMLElement>(
      "[data-table-resize-frame]",
    )!;
    frame.getBoundingClientRect = () => rectWithWidth(640);
    const handle = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize table width"]',
    )!;

    act(() => {
      handle.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: 640,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 840 }),
      );
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });

    expect(frame.style.width).toBe("840px");
    expect(frame.style.minWidth).toBe("840px");
  });
});
