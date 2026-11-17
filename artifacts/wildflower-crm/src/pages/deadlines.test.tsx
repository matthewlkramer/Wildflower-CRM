import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import Deadlines from "./deadlines";

vi.mock("@/pages/grants-calendar", () => ({
  default: () => <p>Application and close list</p>,
}));
vi.mock("@/pages/reporting-deadlines", () => ({
  default: () => <p>Reporting list</p>,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => window.history.replaceState({}, "", "/"));

describe("Deadlines", () => {
  it("opens donor reporting by URL and switches views without leaving Deadlines", async () => {
    window.history.replaceState({}, "", "/deadlines?tab=reporting");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Deadlines />));
      expect(host.querySelector('h1')?.textContent).toBe("Deadlines");
      expect(host.querySelector('[role="tabpanel"][data-state="active"]')?.textContent).toBe("Reporting list");
      const applications = host.querySelector<HTMLButtonElement>('[role="tab"][data-state="inactive"]')!;
      await act(async () => applications.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
      expect(window.location.pathname).toBe("/deadlines");
      expect(window.location.search).toBe("");
      expect(host.querySelector('[role="tabpanel"][data-state="active"]')?.textContent).toBe("Application and close list");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
