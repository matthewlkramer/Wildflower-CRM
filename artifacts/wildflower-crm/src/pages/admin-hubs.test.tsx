// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

import { DataCleanupHub } from "./admin-hubs";
import Admin from "./admin";

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
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Admin />
      </QueryClientProvider>,
    ));

    expect(host.textContent).toContain("Feedback Queue");
    expect(host.textContent).toContain("Future Functionality");
    expect(host.querySelector('[role="tablist"][aria-label="Admin sections"] [aria-selected="true"]')?.textContent).toBe("App Improvements");
    expect(host.querySelector('[role="tabpanel"] [role="tablist"] [aria-selected="true"]')?.textContent).toContain(
      "Future Functionality",
    );
  });

  it("makes the four maintenance tools available inside Admin", async () => {
    window.history.replaceState({}, "", "/admin?tab=maintenance");
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Admin />
      </QueryClientProvider>,
    ));
    expect([...host.querySelectorAll('[role="tabpanel"] a')].map((link) => link.getAttribute("href"))).toEqual([
      "/enrichment-queue",
      "/data-cleanup",
      "/payment-intermediaries",
      "/fundable-projects",
    ]);
  });
});
