/**
 * E2E test: group-reconciled gift unlink on the reconciliation workbench
 * (/reconciliation/clusters).
 *
 * Verifies the honesty contract for grouped QuickBooks links:
 *   1. Three QB staged payments group-reconciled into ONE gift collapse into a
 *      SINGLE unlink action — the three records are never offered individually
 *      (menu label "Unlink from this match" without the chooser ellipsis, and
 *      no radio chooser dialog appears).
 *   2. The confirm dialog carries the group warning: "These 3 QuickBooks
 *      records were reconciled as one group — unlinking removes all of them
 *      together."
 *   3. Confirming reverts ALL THREE group members to pending (counted
 *      payment_applications rows deleted, match_confirmed_at and
 *      approved_by_user_id cleared) while the pre-existing gift is kept.
 *
 * Auth: uses @clerk/testing programmatic sign-in (same pattern as
 * campaigns.spec.ts). Unlink actions are admin-gated, so `beforeAll` signs in
 * once (auto-provisioning the users row) and promotes it to admin via pg;
 * `afterAll` demotes back to team_member.
 *
 * Data: seeded directly via pg with a unique `e2egrpspec<ts>` prefix — an org,
 * a gift (90.00), and three QB deposit-line staged payments (30.00 each). The
 * group reconcile itself goes through the real API
 * (POST /api/staged-payments/group-reconcile) using the authenticated request
 * context, so the unit_groups / payment_applications state is exactly what
 * production writes. Everything is deleted in FK order in `afterAll`.
 *
 * Requirements:
 *   - CLERK_SECRET_KEY set in env.
 *   - DATABASE_URL set in env (the same dev DB used by the API server).
 *   - "Allow testing tokens" enabled in the Clerk dashboard.
 */

import { test, expect } from "@playwright/test";
import { setupClerkTestingToken, clerk } from "@clerk/testing/playwright";
import pg from "pg";

// A +clerk_test subaddress: @clerk/testing's email_code sign-in only accepts
// test emails (fixed OTP, no real mail). The Clerk user must already exist in
// the instance (created once via the Clerk backend API).
const TEST_EMAIL = "e2e-recon-test+clerk_test@wildflowerschools.org";

// Unique per-run ids. SP_A is lexicographically smallest, so the API picks it
// as the group representative.
const RUN = `e2egrpspec${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const GIFT_ID = `${RUN}_gift`;
const SP_A = `${GIFT_ID}_sp_a`;
const SP_B = `${GIFT_ID}_sp_b`;
const SP_C = `${GIFT_ID}_sp_c`;
const REALM = `${RUN}_realm`;
const DEPOSIT = `${RUN}_dep`;
const GIFT_NAME = `E2E Group Gift ${RUN}`;

const GROUP_WARNING =
  "These 3 QuickBooks records were reconciled as one group — unlinking removes all of them together.";

/* ---------- db helpers ---------- */

async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seedGroupFixture(): Promise<void> {
  await withDb(async (c) => {
    await c.query(
      `INSERT INTO organizations (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, `E2E Group Test Org ${RUN}`],
    );
    await c.query(
      `INSERT INTO gifts_and_payments (id, name, amount, organization_id)
       VALUES ($1, $2, '90.00', $3)
       ON CONFLICT (id) DO NOTHING`,
      [GIFT_ID, GIFT_NAME, ORG_ID],
    );
    await c.query(
      `INSERT INTO staged_payments
         (id, realm_id, qb_entity_type, qb_entity_id, qb_line_id, amount,
          qb_deposit_id, organization_id)
       VALUES
         ($1, $4, 'deposit', $1, 'a', '30.00', $5, $6),
         ($2, $4, 'deposit', $2, 'b', '30.00', $5, $6),
         ($3, $4, 'deposit', $3, 'c', '30.00', $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [SP_A, SP_B, SP_C, REALM, DEPOSIT, ORG_ID],
    );
  });
}

async function cleanupFixture(): Promise<void> {
  await withDb(async (c) => {
    // FK order matters: ledger rows first, then group membership, then the
    // staged/gift/org rows themselves.
    await c.query(
      `DELETE FROM payment_applications
       WHERE payment_id IN ($1, $2, $3) OR gift_id = $4`,
      [SP_A, SP_B, SP_C, GIFT_ID],
    );
    // Capture this fixture's group ids BEFORE removing membership, then only
    // delete those groups (if emptied) — never sweep unrelated orphan groups
    // in the shared dev DB.
    const groups = await c.query<{ group_id: string }>(
      `SELECT DISTINCT group_id FROM unit_group_members
       WHERE source_id IN ($1, $2, $3)`,
      [SP_A, SP_B, SP_C],
    );
    await c.query(
      `DELETE FROM unit_group_members WHERE source_id IN ($1, $2, $3)`,
      [SP_A, SP_B, SP_C],
    );
    for (const row of groups.rows) {
      await c.query(
        `DELETE FROM unit_groups ug
         WHERE ug.id = $1
           AND NOT EXISTS (SELECT 1 FROM unit_group_members m WHERE m.group_id = ug.id)`,
        [row.group_id],
      );
    }
    await c.query(`DELETE FROM staged_payments WHERE id IN ($1, $2, $3)`, [
      SP_A,
      SP_B,
      SP_C,
    ]);
    await c.query(`DELETE FROM gift_allocations WHERE gift_id = $1`, [GIFT_ID]);
    await c.query(`DELETE FROM gifts_and_payments WHERE id = $1`, [GIFT_ID]);
    await c.query(`DELETE FROM organizations WHERE id = $1`, [ORG_ID]);
  });
}

/* ---------- one-time setup: provision user, promote to admin, seed ---------- */

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
    // Trigger requireAuth so the `users` row is provisioned, then promote —
    // the workbench unlink actions are admin-gated.
    await page.goto("/reconciliation/clusters");
    await page.waitForLoadState("networkidle");
    await withDb((c) =>
      c.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [TEST_EMAIL]),
    );
  } finally {
    await ctx.close();
  }
  await seedGroupFixture();
});

/* ---------- teardown: remove fixture, demote role ---------- */

test.afterAll(async () => {
  await cleanupFixture();
  await withDb((c) =>
    c.query(`UPDATE users SET role = 'team_member' WHERE email = $1`, [
      TEST_EMAIL,
    ]),
  );
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

/* ---------- test ---------- */

test("group-reconciled QB links collapse into one unlink that reverts all members", async ({
  page,
}) => {
  // Sign-in + workbench navigation + DB polling add up; the default 30s
  // budget is too tight for this end-to-end flow.
  test.setTimeout(120_000);

  // ── Group-reconcile through the real API ─────────────────────────────────
  // page.request shares auth cookies with the signed-in page context (the
  // standalone `request` fixture does NOT and would get a 401).
  const resp = await page.request.post("/api/staged-payments/group-reconcile", {
    data: { giftId: GIFT_ID, stagedPaymentIds: [SP_A, SP_B, SP_C] },
  });
  expect(
    resp.ok(),
    `group-reconcile failed ${resp.status()}: ${await resp.text()}`,
  ).toBe(true);
  const body = (await resp.json()) as { representativeStagedPaymentId: string };
  expect(body.representativeStagedPaymentId).toBe(SP_A);

  // All three members carry a counted QB ledger row.
  const counted = await withDb((c) =>
    c.query(
      `SELECT payment_id FROM payment_applications
       WHERE payment_id IN ($1, $2, $3)
         AND evidence_source = 'quickbooks' AND link_role = 'counted'`,
      [SP_A, SP_B, SP_C],
    ),
  );
  expect(counted.rowCount).toBe(3);

  // ── Surface the cluster on the workbench ─────────────────────────────────
  await page.goto("/reconciliation/clusters");
  await expect(page.getByTestId("input-cluster-search")).toBeVisible();

  // Search by the run prefix — the QB anchor search matches staged ids.
  await page.getByTestId("input-cluster-search").fill(RUN);

  // The reconciled group may live under a non-default lens; try until the
  // cluster row shows up (search input is debounced ~400ms).
  const clusterRow = page.getByTestId(/^cluster-row-/).first();
  const lenses = ["button-lens-link_complete", "button-lens-completed", "button-lens-all_open"];
  for (const lens of lenses) {
    if (await clusterRow.isVisible().catch(() => false)) break;
    await page.getByTestId(lens).click();
    await clusterRow.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  }
  await expect(clusterRow).toBeVisible();

  // Expand the row if the gift facet card is not already shown.
  const giftCard = page.getByTestId(`card-cluster-gift-${GIFT_ID}`);
  if (!(await giftCard.isVisible().catch(() => false))) {
    const toggle = clusterRow.getByTestId(/^button-toggle-/);
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
    } else {
      await clusterRow.click();
    }
  }
  await expect(giftCard).toBeVisible();

  // ── One collapsed unlink action, no per-record chooser ───────────────────
  // The 18px menu trigger can lose Playwright's actionability race against
  // the workbench's polling re-renders, so open it with a forced-click retry.
  const menuBtn = page.getByTestId(`button-gift-menu-${GIFT_ID}`);
  const unlinkItem = page.getByRole("menuitem", {
    name: "Unlink from this match",
    exact: true,
  });
  await expect(async () => {
    await menuBtn.scrollIntoViewIfNeeded();
    await menuBtn.click({ force: true, timeout: 2_000 });
    await expect(unlinkItem).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // The single-option label has NO ellipsis — the ellipsis variant means a
  // chooser would open, i.e. the group was (wrongly) offered as multiple
  // relationships.
  await unlinkItem.click();

  // Straight to the confirm dialog: no chooser, no per-record radios.
  await expect(
    page.getByRole("alertdialog").getByText("Unlink this match?"),
  ).toBeVisible();
  await expect(page.getByText("Which link should be removed?")).toHaveCount(0);
  await expect(page.getByTestId(/^radio-unlink-/)).toHaveCount(0);

  // The confirm dialog carries the whole-group warning.
  await expect(page.getByRole("alertdialog")).toContainText(GROUP_WARNING);

  // ── Confirm and verify ALL members revert to pending ─────────────────────
  await page.getByTestId("button-confirm-revert").click();
  await expect(page.getByRole("alertdialog")).not.toBeVisible();
  await expect(page.getByText("Couldn't unlink")).not.toBeVisible();

  // Ledger rows for all three members are gone…
  await expect
    .poll(
      async () => {
        const r = await withDb((c) =>
          c.query(
            `SELECT count(*)::int AS n FROM payment_applications
             WHERE payment_id IN ($1, $2, $3)`,
            [SP_A, SP_B, SP_C],
          ),
        );
        return (r.rows[0] as { n: number }).n;
      },
      { timeout: 10_000 },
    )
    .toBe(0);

  // …and every staged row is back to pending (no confirmation, no approver).
  const staged = await withDb((c) =>
    c.query(
      `SELECT id FROM staged_payments
       WHERE id IN ($1, $2, $3)
         AND match_confirmed_at IS NULL AND approved_by_user_id IS NULL`,
      [SP_A, SP_B, SP_C],
    ),
  );
  expect(staged.rowCount).toBe(3);

  // The pre-existing gift is kept — unlink only removes the links.
  const gift = await withDb((c) =>
    c.query(`SELECT id FROM gifts_and_payments WHERE id = $1`, [GIFT_ID]),
  );
  expect(gift.rowCount).toBe(1);
});
