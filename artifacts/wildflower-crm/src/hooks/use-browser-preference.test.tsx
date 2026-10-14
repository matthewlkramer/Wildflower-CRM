import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useBrowserPreference } from "./use-browser-preference";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
function Choice({ userId }: { userId: string }) {
  const [value, setValue] = useBrowserPreference(
    userId,
    "meetings-owner",
    "all",
  );
  return (
    <button onClick={() => setValue(value === "all" ? userId : "all")}>
      {value}
    </button>
  );
}
describe("account meeting preference", () => {
  it("survives unmount and reload while remaining isolated between accounts", async () => {
    localStorage.clear();
    const host = document.createElement("div");
    let root = createRoot(host);
    await act(async () => root.render(<Choice userId="first" />));
    await act(async () => host.querySelector("button")!.click());
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Choice userId="first" />));
    expect(host.textContent).toBe("first");
    await act(async () => root.render(<Choice userId="second" />));
    expect(host.textContent).toBe("all");
    await act(async () => root.render(<Choice userId="first" />));
    expect(host.textContent).toBe("first");
    await act(async () => host.querySelector("button")!.click());
    expect(localStorage.getItem("wf-meetings-owner:first")).toBe("all");
    await act(async () => root.unmount());
    localStorage.clear();
  });
});
