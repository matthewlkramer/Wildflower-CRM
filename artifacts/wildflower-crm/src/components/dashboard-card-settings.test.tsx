import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  DashboardCardSettings,
  useDashboardCards,
} from "./dashboard-card-settings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function Settings({ userId }: { userId: string }) {
  const settings = useDashboardCards(userId);
  return <DashboardCardSettings userId={userId} {...settings} />;
}

describe("personal dashboard cards", () => {
  it("restores hidden cards for one account without affecting another account", async () => {
    localStorage.clear();
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Settings userId="owner" />));
      const switchForCleanup = () =>
        host.querySelector<HTMLButtonElement>(
          '[aria-label="Show Data cleanup and integrity"]',
        )!;
      await act(async () => switchForCleanup().click());
      expect(switchForCleanup().getAttribute("aria-checked")).toBe("false");
      await act(async () => root.render(<Settings userId="other" />));
      expect(switchForCleanup().getAttribute("aria-checked")).toBe("true");
      await act(async () => root.render(<Settings userId="owner" />));
      expect(switchForCleanup().getAttribute("aria-checked")).toBe("false");
      await act(async () => switchForCleanup().click());
      expect(switchForCleanup().getAttribute("aria-checked")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      localStorage.clear();
    }
  });

  it("keeps cards available when saved browser preferences are corrupt", async () => {
    localStorage.setItem("wf-dashboard-cards:owner", "not json");
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Settings userId="owner" />));
      expect(
        host
          .querySelector('[aria-label="Show Data cleanup and integrity"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
    } finally {
      await act(async () => root.unmount());
      localStorage.clear();
    }
  });
});
