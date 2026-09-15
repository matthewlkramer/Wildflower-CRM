// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wouter", () => ({
  useLocation: () => ["/opportunities", vi.fn()],
  Link: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@clerk/react", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
  useUser: () => ({ user: { fullName: "Admin User", firstName: "Admin" } }),
}));
vi.mock("@/hooks/use-is-admin", () => ({ useIsAdmin: () => true }));
vi.mock("@/components/entity-filter", () => ({
  HeaderEntityFilter: () => <span>Entity filter</span>,
}));
vi.mock("@/components/command-palette", () => ({
  CommandPaletteProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  CommandPaletteTrigger: () => <button>Search</button>,
}));
vi.mock("@/components/meeting-launcher-dialog", () => ({
  MeetingLauncherDialog: () => <button>Meeting</button>,
}));
vi.mock("@/components/feedback-dialog", () => ({
  FeedbackDialog: () => <button>Feedback</button>,
}));
vi.mock("@/components/log-interaction-dialog", () => ({
  LogInteractionDialog: () => <button>Interaction</button>,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => children,
  SheetTrigger: ({ children }: { children: React.ReactNode }) => children,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import Layout from "./layout";

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

describe("application layout", () => {
  it("keeps the action header fixed while the main content scrolls", async () => {
    await act(async () => root.render(<Layout>Page content</Layout>));

    expect(
      host.querySelector('[data-testid="app-shell"]')?.className,
    ).toContain("h-[100dvh]");
    expect(
      host.querySelector('[data-testid="app-shell"]')?.className,
    ).toContain("overflow-hidden");
    expect(
      host.querySelector('[data-testid="app-header"]')?.className,
    ).toContain("sticky");
    expect(
      host.querySelector('[data-testid="app-header"]')?.className,
    ).toContain("top-0");
    expect(host.querySelector("main")?.className).toContain("overflow-y-auto");
  });

  it("uses consolidated admin links and places gifts and pledges with finance", async () => {
    await act(async () => root.render(<Layout>Page content</Layout>));

    const sidebar = host.querySelector('[data-testid="desktop-sidebar"]')!;
    const labels = Array.from(sidebar.querySelectorAll("a"), (link) =>
      link.textContent?.trim(),
    );
    expect(labels).toContain("Data Cleanup");
    expect(labels).toContain("App Improvements");
    expect(labels).not.toContain("Users");
    expect(labels).not.toContain("Feedback");
    expect(labels).not.toContain("Potential Duplicates");
    expect(labels).not.toContain("Cleanup Queue");
    expect(labels).not.toContain("Restriction Text Review");

    const text = sidebar.textContent ?? "";
    expect(text.indexOf("Pledges")).toBeGreaterThan(
      text.indexOf("Finance & Operations"),
    );
    expect(text.indexOf("Gifts")).toBeGreaterThan(
      text.indexOf("Finance & Operations"),
    );
  });
});
