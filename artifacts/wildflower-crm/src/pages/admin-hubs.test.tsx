// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => true }));
vi.mock("@/pages/admin-feedback", () => ({
  default: () => <div>Feedback content</div>,
}));
vi.mock("@/pages/cleanup-queue", () => ({
  default: () => <div>Cleanup content</div>,
}));
vi.mock("@/pages/future-functionality", () => ({
  default: () => <div>Future functionality content</div>,
}));
vi.mock("@/pages/potential-duplicates", () => ({
  default: () => <div>Duplicate content</div>,
}));
vi.mock("@/pages/restriction-text-review", () => ({
  default: () => <div>Restriction content</div>,
}));

import { AppImprovementsHub, DataCleanupHub } from "./admin-hubs";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("consolidated admin hubs", () => {
  it("groups all cleanup worklists on one page", async () => {
    window.history.replaceState(
      {},
      "",
      "/data-cleanup?tab=potential-duplicates",
    );
    await act(async () => root.render(<DataCleanupHub />));

    expect(host.textContent).toContain("Cleanup Queue");
    expect(host.textContent).toContain("Potential Duplicates");
    expect(host.textContent).toContain("Restriction Text Review");
    expect(host.querySelector('[data-state="active"]')?.textContent).toContain(
      "Potential Duplicates",
    );
  });

  it("groups feedback and future functionality on one page", async () => {
    window.history.replaceState(
      {},
      "",
      "/admin/app-improvements?tab=future-functionality",
    );
    await act(async () => root.render(<AppImprovementsHub />));

    expect(host.textContent).toContain("Feedback Queue");
    expect(host.textContent).toContain("Future Functionality");
    expect(host.querySelector('[data-state="active"]')?.textContent).toContain(
      "Future Functionality",
    );
  });
});
