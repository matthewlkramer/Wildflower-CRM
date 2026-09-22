// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  role: "admin",
  enabled: false,
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  invalidate: vi.fn(),
}));
const rows = [
  {
    id: "admin",
    email: "admin@wildflowerschools.org",
    displayName: "Admin User",
    role: "admin",
    archivedAt: null,
  },
  {
    id: "colleague",
    email: "colleague@wildflowerschools.org",
    displayName: "Active Colleague",
    role: "team_member",
    archivedAt: null,
  },
  {
    id: "retired",
    email: "retired@wildflowerschools.org",
    displayName: "Retired Colleague",
    role: "finance",
    archivedAt: "2026-01-01",
  },
];
vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => ({ data: { id: "admin", role: api.role } }),
  useAdminListUsers: (options: { query: { enabled: boolean } }) => {
    api.enabled = options.query.enabled;
    return { data: rows };
  },
  useAdminCreateUser: () => ({ mutate: api.create }),
  useAdminUpdateUser: () => ({ mutate: api.update }),
  useArchiveUser: () => ({ mutate: api.archive }),
  useUnarchiveUser: () => ({ mutate: api.restore }),
  getAdminListUsersQueryKey: () => ["/api/admin/users"],
  getListUsersQueryKey: () => ["/api/users"],
  getGetCurrentUserQueryKey: () => ["/api/users/me"],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: api.invalidate }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/user-picker", () => ({
  userDisplayName: (user: { displayName: string }) => user.displayName,
}));
import AdminUsers from "./admin-users";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.role = "admin";
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render() {
  await act(async () => root.render(<AdminUsers />));
}
async function click(selector: string) {
  await act(async () =>
    (document.querySelector(selector) as HTMLButtonElement).click(),
  );
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = document.querySelector(selector) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("admin Users page", () => {
  it("does not load the directory or offer controls to a team member", async () => {
    api.role = "team_member";
    await render();
    expect(api.enabled).toBe(false);
    expect(host.textContent).toContain("Only admins");
    expect(host.querySelector("button")).toBeNull();
  });
  it("defaults to active users, disables self-deactivation, and dispatches access changes", async () => {
    await render();
    expect(api.enabled).toBe(true);
    expect(host.textContent).not.toContain("Retired Colleague");
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Deactivate admin@wildflowerschools.org"]',
      )!.disabled,
    ).toBe(true);
    await click('[aria-label="Deactivate colleague@wildflowerschools.org"]');
    expect(api.archive).toHaveBeenCalledWith({ id: "colleague" });
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(
        '[aria-label="Filter by access"]',
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!.call(select, "inactive");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("Retired Colleague");
    await click('[aria-label="Restore retired@wildflowerschools.org"]');
    expect(api.restore).toHaveBeenCalledWith({ id: "retired" });
    await fill('[aria-label="Search users"]', "retired");
    expect(host.textContent).not.toContain("Active Colleague");
  });
  it("creates a normalized team member from the form without sending an invitation", async () => {
    await render();
    await act(async () =>
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent === "Add user")!
        .click(),
    );
    expect(document.body.textContent).toContain("does not send an email");
    await fill("#user-email", "New.Person@wildflowerschools.org");
    await fill("#user-first-name", "New");
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(api.create).toHaveBeenCalledWith({
      data: {
        email: "new.person@wildflowerschools.org",
        firstName: "New",
        lastName: null,
        displayName: null,
        role: "team_member",
      },
    });
  });
  it("makes login email immutable and prevents changing your own role", async () => {
    await render();
    await click('[aria-label="Edit admin@wildflowerschools.org"]');
    expect(
      document.querySelector<HTMLInputElement>("#user-email")!.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLSelectElement>("#user-role")!.disabled,
    ).toBe(true);
  });
});
