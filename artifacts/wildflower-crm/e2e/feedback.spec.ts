import { test, expect } from "@playwright/test";
test("feedback workflow: browser preferences, mobile search, record actions, and readable tasks", async ({
  page,
}) => {
  const writes: Array<{ path: string; body: unknown }> = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let data: unknown = [];
    if (req.method() !== "GET") {
      writes.push({ path: url.pathname, body: req.postDataJSON() });
      data = {};
    } else if (url.pathname === "/api/users/me" || url.pathname === "/api/me")
      data = {
        id: "synthetic-user",
        role: "admin",
        email: "test@example.test",
      };
    else if (url.pathname === "/api/users")
      data = [
        {
          id: "synthetic-user",
          role: "admin",
          email: "test@example.test",
          displayName: "Synthetic Tester",
        },
      ];
    else if (url.pathname === "/api/entities")
      data = [{ id: "synthetic-entity", name: "Synthetic fund", active: true }];
    else if (url.pathname === "/api/calendar-events")
      data = { data: [], pagination: { page: 1, limit: 500, total: 0 } };
    else if (url.pathname === "/api/search")
      data = {
        people: [{ id: "synthetic-person", label: "Synthetic Person" }],
        organizations: [],
        households: [],
        opportunities: [],
        gifts: [],
      };
    else if (url.pathname === "/api/conference-events")
      data = [
        {
          id: "synthetic-conference",
          conferenceTypeName: "Synthetic Summit",
          year: 2026,
          status: "completed",
        },
      ];
    await route.fulfill({ json: data });
  });
  await page.goto("/e2e/fixtures/feedback.html");
  await page.getByText("Customize dashboard").click();
  for (const label of ["Moves", "Application/close deadlines", "Projections"])
    await page.getByRole("switch", { name: `Show ${label}` }).click();
  await page.getByTestId("filter-meetings-owner").click();
  await page.getByRole("option", { name: "Synthetic Tester" }).click();
  await page.reload();
  await expect(page.getByTestId("filter-meetings-owner")).toContainText(
    "Synthetic Tester",
  );
  await page.getByText("Customize dashboard").click();
  for (const label of ["Moves", "Application/close deadlines", "Projections"])
    await expect(
      page.getByRole("switch", { name: `Show ${label}` }),
    ).toHaveAttribute("aria-checked", "false");
  await page.setViewportSize({ width: 375, height: 812 });
  const header = page.getByTestId("app-header");
  expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Search all records" }).click();
  await page.getByTestId("command-palette-input").fill("Synthetic");
  await expect(
    page.getByTestId("palette-person-synthetic-person"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit note", exact: true }).click();
  await page.getByRole("textbox", { name: "Note text" }).fill("Corrected note");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect
    .poll(() => writes.some((w) => w.path === "/api/notes/synthetic-note"))
    .toBe(true);
  await page
    .getByRole("button", { name: "Edit interaction", exact: true })
    .click();
  await page.getByTestId("input-interaction-summary").fill("Corrected call");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() =>
      writes.some((w) => w.path === "/api/interactions/synthetic-interaction"),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Record conference attendance" })
    .click();
  await page.getByRole("button", { name: "Synthetic Summit 2026" }).click();
  await expect
    .poll(() =>
      writes.some(
        (w) =>
          w.path === "/api/conference-events/synthetic-conference/attendance",
      ),
    )
    .toBe(true);
  await expect(page.getByText("No emails.")).toHaveCount(1);
  const add = page.getByRole("button", { name: "Add email", exact: true });
  expect(await add.boundingBox()).not.toBeNull();
  await page.getByRole("button", { name: "Review task proposals" }).click();
  const task = page.getByRole("textbox", {
    name: "Proposed task 1",
    exact: true,
  });
  await expect(task).toBeVisible();
  expect(await task.evaluate((el) => el.tagName)).toBe("TEXTAREA");
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThan(800);
});
