import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddTaskDialog, TasksPanel } from "./tasks-panel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/user-picker", () => ({
  useUserNameMap: () => new Map(),
  userDisplayName: () => "User",
}));
vi.mock("@/components/entity-links-editor", () => ({
  EntityLinksEditor: () => null,
  MentionsPicker: () => null,
  EMPTY_LINKS: {
    personIds: [],
    organizationIds: [],
    householdIds: [],
    opportunityIds: [],
    giftIds: [],
    grantLeadIds: [],
  },
}));
vi.mock("@workspace/api-client-react", () => ({
  useListUsers: () => ({ data: [] }),
  getListUsersQueryKey: () => ["users"],
  getListTasksQueryKey: () => ["tasks"],
  useCreateTask: () => ({ mutate: mocks.create, isPending: false }),
  useUpdateTask: () => ({ mutate: mocks.update, mutateAsync: mocks.update }),
  useDeleteTask: () => ({ mutate: vi.fn() }),
  useListTasks: () => ({
    data: {
      data: [
        {
          id: "report",
          kind: "general",
          status: "open",
          title: "Final report",
          dueDate: "2026-07-10",
          description: null,
        },
      ],
    },
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.create.mockClear();
  mocks.update.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function control<T extends HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`Missing control ${id}`);
  return el;
}
function click(id: string) {
  act(() => control<HTMLButtonElement>(id).click());
}
function fill(id: string, value: string) {
  const el = control<HTMLInputElement | HTMLTextAreaElement>(id);
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function choose(id: string, label: string) {
  act(() =>
    control(id).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  const option = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((el) => el.textContent === label);
  if (!option) throw new Error(`Missing option ${label}`);
  act(() => option.click());
}

describe("reporting tasks in the normal task workflow", () => {
  it.each(["general", "reporting_deadline"])(
    "creates a %s task with its report source and pledge link",
    async (kind) => {
      await act(async () =>
        root.render(<AddTaskDialog ctx={{ opportunityId: "pledge" }} />),
      );
      click("button-add-task");
      if (kind === "reporting_deadline")
        choose("select-new-task-kind", "Reporting deadline");
      fill("input-task-title", "Final report");
      fill("input-task-due", "2026-07-10");
      fill(
        "input-task-description",
        "Report: https://docs.google.com/document/d/example/edit",
      );
      click("button-save-task");
      expect(mocks.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind,
          title: "Final report",
          dueDate: "2026-07-10",
          opportunityIds: ["pledge"],
          description:
            "Report: https://docs.google.com/document/d/example/edit",
        }),
      });
    },
  );

  it("can classify an existing task and attach its report without changing completion", async () => {
    await act(async () => root.render(<TasksPanel opportunityId="pledge" />));
    expect(container.textContent).toContain("Jul 10, 2026");
    click("button-edit-task-kind-report");
    choose("select-task-kind-report", "Reporting deadline");
    await act(async () =>
      control<HTMLButtonElement>("button-save-task-kind-report").click(),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      id: "report",
      data: { kind: "reporting_deadline" },
    });
    click("button-edit-task-description-report");
    fill(
      "textarea-task-description-report",
      "Submitted report: https://docs.google.com/document/d/example/edit",
    );
    await act(async () =>
      control<HTMLButtonElement>("button-save-task-description-report").click(),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      id: "report",
      data: {
        description:
          "Submitted report: https://docs.google.com/document/d/example/edit",
      },
    });
  });
});
