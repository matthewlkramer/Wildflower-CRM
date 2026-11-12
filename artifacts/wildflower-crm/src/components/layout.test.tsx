// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ path: "/opportunities" }));

vi.mock("wouter", () => ({
  useLocation: () => [route.path, vi.fn()],
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
  route.path = "/opportunities";
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

  it("groups commitments with the pipeline and gift processing with reconciliation", async () => {
    await act(async () => root.render(<Layout>Page content</Layout>));

    const sidebar = host.querySelector('[data-testid="desktop-sidebar"]')!;
    const labels = Array.from(sidebar.querySelectorAll("a"), (link) =>
      link.textContent?.trim(),
    );
    expect(labels).toContain("Admin");
    expect(labels).toContain("Deadlines");
    for (const label of [
      "App Improvements",
      "Enrichment Queue",
      "Data Cleanup",
      "Payment Intermediaries",
      "Fundable Projects",
      "Application/Close Deadlines",
      "Reporting Deadlines",
    ]) {
      expect(labels).not.toContain(label);
    }
    expect(labels).not.toContain("Users");
    expect(labels).not.toContain("Feedback");
    expect(labels).not.toContain("Potential Duplicates");
    expect(labels).not.toContain("Cleanup Queue");
    expect(labels).not.toContain("Restriction Text Review");
    expect(labels).not.toContain("Top Priorities");

    const text = sidebar.textContent ?? "";
    const pipelineSections = Array.from(
      sidebar.querySelectorAll('[data-testid="primary-navigation"] > div'),
    ).filter((section) => section.textContent?.trim() === "Donors & pipeline");
    expect(pipelineSections).toHaveLength(1);
    expect(text.indexOf("Individuals")).toBeGreaterThan(
      text.indexOf("Donors & pipeline"),
    );
    expect(text.indexOf("Organizations")).toBeGreaterThan(
      text.indexOf("Donors & pipeline"),
    );
    expect(text.indexOf("Pledges")).toBeGreaterThan(
      text.indexOf("Opportunities"),
    );
    expect(text.indexOf("Pledges")).toBeLessThan(text.indexOf("Gift processing"));
    expect(text.indexOf("Gifts")).toBeGreaterThan(
      text.indexOf("Reconciliation"),
    );
    const developmentLinks = text.split("Development team")[1]?.split("Administration")[0];
    expect(developmentLinks).toContain("Development Team Meetings");
    expect(developmentLinks).toContain("Campaigns");
  });

  it.each([
    ["/meetings/development/example", "Development Team Meetings"],
    ["/payment-intermediaries/example", "Admin"],
    ["/admin/app-improvements", "Admin"],
  ])("highlights the enclosing section for %s", async (path, label) => {
    route.path = path;
    await act(async () => root.render(<Layout>Page content</Layout>));
    const sidebar = host.querySelector('[data-testid="desktop-sidebar"]')!;
    const activeLinks = [...sidebar.querySelectorAll('[aria-current="page"]')];
    expect(activeLinks.map((link) => link.getAttribute("aria-label"))).toEqual([label]);
  });

  it("uses compact vertical navigation spacing", async () => {
    await act(async () => root.render(<Layout>Page content</Layout>));

    const navigation = host.querySelector('[data-testid="primary-navigation"]');
    expect(navigation?.className).toContain("space-y-0.5");
    expect(navigation?.querySelector("a")?.className).toContain("py-1.5");
  });
});
