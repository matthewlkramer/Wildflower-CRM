/**
 * E2E coverage for the activity-feed relevance disclosure. Requires the
 * normal Clerk testing credentials, a running app, and DATABASE_URL.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { setupClerkTestingToken, clerk } from "@clerk/testing/playwright";
import pg from "pg";

const TEST_EMAIL = "e2e-hh-test@wildflowerschools.org";

async function post(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, string>> {
  const response = await request.post(`/api${path}`, { data: body });
  if (!response.ok()) {
    throw new Error(
      `POST /api${path} failed ${response.status()}: ${await response.text()}`,
    );
  }
  return response.json();
}

test.beforeEach(async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({
    page,
    signInParams: { strategy: "email_code", identifier: TEST_EMAIL },
  });
});

test("filtered media is disclosed on demand while pinned media stays visible", async ({
  page,
  request,
}) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) test.skip(true, "DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const stamp = Date.now();
  const person = await post(request, "/people", {
    firstName: "MediaE2E",
    lastName: `Person-${stamp}`,
  });
  const createdIds: string[] = [];

  try {
    for (const [label, pinned] of [
      ["Relevant media result", false],
      ["Likely irrelevant media result", false],
      ["Pinned low-score media result", true],
    ] as const) {
      const media = await post(request, "/media-mentions", {
        publicationName: "E2E Press",
        title: `${label} ${stamp}`,
        url: `https://example.org/media-e2e/${stamp}/${createdIds.length}`,
        personIds: [person.id],
        pinned,
      });
      createdIds.push(media.id);
    }

    await pool.query(
      `UPDATE media_mentions
       SET relevance_score = CASE WHEN id = $1 THEN 0.9 ELSE 0.1 END,
           is_filtered = id <> $1
       WHERE id = ANY($2::text[])`,
      [createdIds[0], createdIds],
    );

    await page.goto(`/individuals/${person.id}`);
    await page.getByTestId("activity-source-media").click();

    await expect(
      page.getByText(`Relevant media result ${stamp}`),
    ).toBeVisible();
    await expect(
      page.getByText(`Pinned low-score media result ${stamp}`),
    ).toBeVisible();
    await expect(
      page.getByText(`Likely irrelevant media result ${stamp}`),
    ).toHaveCount(0);
    await expect(page.getByTestId("media-filtered-disclosure")).toContainText(
      "1 article hidden as likely irrelevant — show all",
    );

    await page.getByTestId("media-filtered-toggle").click();
    const filteredRow = page.getByTestId(`media-row-${createdIds[1]}`);
    await expect(filteredRow).toBeVisible();
    await expect(filteredRow).toHaveAttribute("data-filtered", "true");
    await expect(filteredRow.getByText("May not be relevant")).toBeVisible();
  } finally {
    if (createdIds.length) {
      await pool.query(
        "DELETE FROM media_mentions WHERE id = ANY($1::text[])",
        [createdIds],
      );
    }
    await pool.end();
    await post(request, `/people/${person.id}/archive`, {});
  }
});
