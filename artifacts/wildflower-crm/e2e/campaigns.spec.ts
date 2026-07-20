/**
 * E2E tests: Campaigns admin page — create, edit, archive, unarchive.
 *
 * Covers:
 *   1. Navigate to /campaigns as an admin.
 *   2. Create a new campaign (slug + name).
 *   3. Edit the campaign name via the dialog.
 *   4. Archive the campaign — "Campaign archived" toast fires and the row
 *      gains an Archived badge.
 *   5. Unarchive the campaign — "Campaign unarchived" toast fires and the row
 *      reverts to Active.
 *
 * Auth: uses @clerk/testing programmatic sign-in.  Because the Campaigns page
 * gates create/edit/archive behind `useIsAdmin()`, the signed-in user must
 * have `role = 'admin'` in the CRM `users` table.  We handle this in
 * `beforeAll` by:
 *   1. Signing in once (which triggers `requireAuth` → auto-provisions the
 *      `users` row with `role = 'team_member'`).
 *   2. Directly promoting that row to `role = 'admin'` via pg.
 *
 * Data: each test generates a unique slug via `Date.now()` so runs never
 * conflict.  The created campaign is archived at the end of the test (which
 * is already tested), and cleaned up via a direct API DELETE-equivalent
 * (archive keeps the record but removes it from active pickers, which is the
 * app's soft-delete pattern).
 *
 * Requirements:
 *   - CLERK_SECRET_KEY set in env.
 *   - DATABASE_URL set in env (the same dev DB used by the API server).
 *   - "Allow testing tokens" enabled in the Clerk dashboard.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { setupClerkTestingToken, clerk } from "@clerk/testing/playwright";
import pg from "pg";

// Re-use the shared CRM e2e test account.  This email must already exist in
// the Clerk testing environment (created by the household-members spec or any
// prior run).  The `beforeAll` promotes it to admin and `afterAll` demotes it
// back to team_member so other tests that expect non-admin are unaffected.
const TEST_EMAIL = "e2e-hh-test@wildflowerschools.org";

/* ---------- helpers ---------- */

async function apiPost(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const resp = await request.post(`/api${path}`, { data: body });
  if (!resp.ok()) {
    throw new Error(`POST /api${path} failed ${resp.status()}: ${await resp.text()}`);
  }
  return resp.json();
}

/* ---------- admin promotion ---------- */

async function ensureAdminRole(email: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [email]);
  } finally {
    await client.end();
  }
}

/* ---------- one-time setup: sign in to create the DB user, then promote ---------- */

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await setupClerkTestingToken({ page });
    await page.goto("/");
    await clerk.signIn({
      page,
      signInParams: { strategy: "email_code", identifier: TEST_EMAIL },
    });
    // Trigger requireAuth so the `users` row is provisioned.
    await page.goto("/campaigns");
    await page.waitForLoadState("networkidle");
    // Now promote in the DB.
    await ensureAdminRole(TEST_EMAIL);
  } finally {
    await ctx.close();
  }
});

/* ---------- role teardown ---------- */

test.afterAll(async () => {
  // Demote back to team_member so other specs that expect non-admin behaviour
  // are not polluted by the promotion this suite applied.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE users SET role = 'team_member' WHERE email = $1`, [TEST_EMAIL]);
  } finally {
    await client.end();
  }
});

/* ---------- per-test sign-in ---------- */

test.beforeEach(async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({
    page,
    signInParams: { strategy: "email_code", identifier: TEST_EMAIL },
  });
});

/* ---------- tests ---------- */

test("create, edit, archive, and unarchive a campaign", async ({ page, request }) => {
  const ts = Date.now();
  const slug = `e2e-test-${ts}`;
  const name = `E2E Campaign ${ts}`;
  const editedName = `${name} (edited)`;

  // ── Navigate ──────────────────────────────────────────────────────────────

  await page.goto("/campaigns");
  await expect(page.getByTestId("campaigns-card")).toBeVisible();

  // ── Create ────────────────────────────────────────────────────────────────

  await page.getByTestId("add-campaign").click();
  await expect(page.getByTestId("campaign-dialog")).toBeVisible();

  await page.getByTestId("campaign-slug").fill(slug);
  await page.getByTestId("campaign-name").fill(name);
  await page.getByTestId("campaign-submit").click();

  // Dialog closes and the new row appears in the table.
  await expect(page.getByTestId("campaign-dialog")).not.toBeVisible();
  await expect(page.getByTestId(`campaign-row-${slug}`)).toBeVisible();
  await expect(page.getByTestId(`campaign-row-${slug}`)).toContainText(slug);

  // ── Edit name ─────────────────────────────────────────────────────────────

  await page.getByTestId(`campaign-name-${slug}`).click();
  await expect(page.getByTestId("campaign-dialog")).toBeVisible();

  const nameInput = page.getByTestId("campaign-name");
  await nameInput.clear();
  await nameInput.fill(editedName);
  await page.getByTestId("campaign-submit").click();

  await expect(page.getByTestId("campaign-dialog")).not.toBeVisible();
  await expect(page.getByTestId(`campaign-row-${slug}`)).toContainText(editedName);

  // ── Archive ───────────────────────────────────────────────────────────────

  await page.getByTestId(`button-archive-campaign-${slug}`).click();

  // Toast fires.
  await expect(page.getByText("Campaign archived")).toBeVisible();

  // The row now shows the Archived badge (row is still visible because the
  // page re-fetches and the admin already has showArchived=false, so the
  // archived row disappears from the default view — toggle it on first).
  await page.getByTestId("toggle-show-archived-campaigns").click();
  const row = page.getByTestId(`campaign-row-${slug}`);
  await expect(row).toBeVisible();
  await expect(row.getByText("Archived")).toBeVisible();

  // ── Unarchive ─────────────────────────────────────────────────────────────

  // After archiving, the archive button toggles to "Unarchive".
  await page.getByTestId(`button-archive-campaign-${slug}`).click();

  await expect(page.getByText("Campaign unarchived")).toBeVisible();

  // Row reverts to Active.
  await expect(row.getByText("Active")).toBeVisible();
  await expect(row.getByText("Archived")).not.toBeVisible();

  // ── Cleanup ───────────────────────────────────────────────────────────────
  // Archive again so the test campaign doesn't pollute the active list.
  // (archive is the app's soft-delete; there is no hard-delete for campaigns)
  await page.getByTestId(`button-archive-campaign-${slug}`).click();
  await expect(page.getByText("Campaign archived")).toBeVisible();
});
