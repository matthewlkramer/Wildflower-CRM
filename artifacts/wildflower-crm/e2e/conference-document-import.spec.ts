import { expect, test } from "@playwright/test";

test("preview, map, approve/reject, retry a row and resume a directory import", async ({
  page,
}) => {
  const cells = [
    ["Alex Chen", "Civic Alliance", "Director"],
    ["Robin Ames", "Civic Alliance", "Program lead"],
    ["Jamie Reed", "Unknown Foundation", "Trustee"],
  ];
  const headers = ["Displayed name", "Employer", "Displayed title"];
  const rows = cells.map((c, i) => ({
    id: `r${i}`,
    rowNumber: i + 2,
    rawName: c[0],
    rawOrganization: c[1],
    rawTitle: c[2],
    rawCells: c,
    category: ["reliable", "new_person_existing_org", "other_unmatched"][i],
    matchedOrganizationId: i < 2 ? "org1" : null,
    matchStatus: i ? "unmatched" : "exact",
    matchEvidence: "Synthetic reviewed evidence",
    matchConfidence: i ? "low" : "high",
    disposition: "pending",
    reviewError: null as string | null,
  }));
  const batch = {
    id: "synthetic-batch",
    conferenceEventId: "synthetic-event",
    status: "staged",
    rows,
    createdAt: new Date().toISOString(),
  };
  let staged = false;
  let approvals = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/conference-import-preview")) {
      await route.fulfill({
        json: {
          headers,
          sheets: [],
          rowCount: 3,
          rows: cells.map((c, i) => ({ rowNumber: i + 2, cells: c })),
        },
      });
      return;
    }
    if (url.pathname.endsWith("/synthetic-event/imports")) {
      expect(route.request().postDataJSON().columns).toEqual({
        name: 0,
        organization: 1,
        title: 2,
      });
      staged = true;
      await route.fulfill({ json: batch });
      return;
    }
    if (url.pathname.endsWith("/synthetic-batch/confirm")) {
      const body = route.request().postDataJSON();
      approvals++;
      expect(staged).toBe(true);
      for (const r of rows) {
        if (body.rejectedRowIds.includes(r.id)) r.disposition = "skip";
        else if (body.acceptedRowIds.includes(r.id)) {
          if (r.id === "r2" && !body.newPeople?.r2?.foundationEvidence)
            r.reviewError =
              "New organizations require explicit foundation evidence.";
          else {
            r.disposition = "accept";
            r.reviewError = null;
          }
        }
      }
      batch.status = rows.some((r) => r.disposition === "pending")
        ? "staged"
        : "confirmed";
      await route.fulfill({ json: batch });
      return;
    }
    if (url.pathname.endsWith("/conference-imports/synthetic-batch")) {
      await route.fulfill({ json: batch });
      return;
    }
    await route.fulfill({
      json: { data: [], pagination: { total: 0, page: 1, limit: 20 } },
    });
  });
  await page.goto("/e2e/fixtures/conference-import.html");
  await expect(
    page.getByText("Being listed is registration evidence", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("CSV or XLSX (maximum 2 MiB)")
    .setInputFiles({
      name: "synthetic-directory.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [headers, ...cells].map((c) => c.join(",")).join("\n"),
      ),
    });
  await page
    .getByRole("button", { name: "Preview document", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "Alex Chen", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("organization column", { exact: true })
    .selectOption("1");
  await page.getByLabel("title column", { exact: true }).selectOption("2");
  await page
    .getByRole("button", { name: "Stage mapped rows for review" })
    .click();
  await expect(page.getByRole("status")).toContainText("3 pending");
  expect(approvals).toBe(0);
  await page.getByRole("button", { name: "Select reliable matches" }).click();
  const robin = page
    .locator("div.rounded-md.border.p-3")
    .filter({ hasText: "Row 3: Robin Ames" });
  await robin.getByLabel("Reject / skip", { exact: true }).check();
  const jamie = page
    .locator("div.rounded-md.border.p-3")
    .filter({ hasText: "Row 4: Jamie Reed" });
  await jamie
    .getByRole("button", { name: "Prepare new-person proposal" })
    .click();
  await jamie
    .getByLabel("Approve registration and create reviewed records", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Apply 2 approvals and 1 rejections" })
    .click();
  await expect(page.getByRole("status")).toContainText("1 errors");
  await jamie
    .getByLabel("Row 4 foundation evidence")
    .fill("Reviewed official synthetic registry: this is a foundation.");
  await jamie
    .getByLabel("Approve registration and create reviewed records", {
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Apply 1 approvals and 0 rejections" })
    .click();
  await expect(page.getByRole("status")).toContainText("0 pending");
  expect(approvals).toBe(2);
  await page.getByLabel("Resume import ID").fill("synthetic-batch");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("2 approved");
  await page.screenshot({
    path: "test-results/conference-document-import.png",
    fullPage: true,
  });
});
