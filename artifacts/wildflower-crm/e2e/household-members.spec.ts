/**
 * E2E tests: household members in the People card on individual detail pages.
 *
 * Covers:
 *   1. A person with a household shows other members with connection label and
 *      household name; the subject person is excluded from the list.
 *   2. A person with no household shows no household section and no Edit button.
 *   3. Hide-inactive toggle hides "past" members and reveals them on toggle-off.
 *   4. "Edit household" button navigates to the household detail page.
 *
 * Auth: uses @clerk/testing programmatic sign-in, which requires:
 *   - CLERK_SECRET_KEY set in env (same key the API server uses)
 *   - "Allow testing tokens" enabled in the Clerk dashboard for this app
 *     (Application → Configure → Testing)
 *
 * Data: each test creates isolated people/households/roles via the API and
 * archives them in cleanup, so runs are idempotent and leave no permanent junk.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { setupClerkTestingToken, clerk } from "@clerk/testing/playwright";

const TEST_EMAIL = "e2e-hh-test@wildflowerschools.org";

/* ---------- helpers ---------- */

async function post(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, string>> {
  const resp = await request.post(`/api${path}`, { data: body });
  if (!resp.ok()) {
    throw new Error(
      `POST /api${path} failed ${resp.status()}: ${await resp.text()}`,
    );
  }
  return resp.json();
}

/* ---------- auth ---------- */

test.beforeEach(async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({
    page,
    signInParams: {
      strategy: "email_code",
      identifier: TEST_EMAIL,
    },
  });
});

/* ---------- tests ---------- */

test("current and past household members appear in People card with label and household name", async ({
  page,
  request,
}) => {
  const ts = Date.now();
  const hhName = `TestHousehold-${ts}`;

  const hh = await post(request, "/households", { name: hhName });
  const hhId = hh.id;

  const alice = await post(request, "/people", {
    firstName: "AliceE2E",
    lastName: `HH-${ts}`,
  });
  const bob = await post(request, "/people", {
    firstName: "BobE2E",
    lastName: `HH-${ts}`,
  });
  const dave = await post(request, "/people", {
    firstName: "DaveE2E",
    lastName: `HHSubject-${ts}`,
  });

  await post(request, "/people-entity-roles", {
    personId: alice.id,
    entityType: "household",
    householdId: hhId,
    current: "current",
    externalTitleOrRole: "Spouse",
  });
  await post(request, "/people-entity-roles", {
    personId: bob.id,
    entityType: "household",
    householdId: hhId,
    current: "past",
  });
  await post(request, "/people-entity-roles", {
    personId: dave.id,
    entityType: "household",
    householdId: hhId,
    current: "current",
  });

  await page.goto(`/individuals/${dave.id}`);

  const peopleSection = page.locator("text=People").first().locator("..");
  await expect(peopleSection).toBeVisible();

  await expect(page.getByText("AliceE2E", { exact: false })).toBeVisible();
  await expect(page.getByText("BobE2E", { exact: false })).toBeVisible();

  await expect(page.getByText(`Spouse · ${hhName}`, { exact: false })).toBeVisible();
  await expect(page.getByText(hhName, { exact: false }).first()).toBeVisible();

  await expect(
    page.getByRole("link", { name: `Edit ${hhName}` }),
  ).toBeVisible();

  const memberRows = page.locator(".people-card, [data-testid='people-card']");
  await expect(
    page.getByRole("link", { name: "DaveE2E", exact: false }),
  ).toHaveCount(0);

  await post(request, `/people/${alice.id}/archive`, {});
  await post(request, `/people/${bob.id}/archive`, {});
  await post(request, `/people/${dave.id}/archive`, {});
  await post(request, `/households/${hhId}/archive`, {});
});

test("hide-inactive toggle hides former household members and restores them on toggle-off", async ({
  page,
  request,
}) => {
  const ts = Date.now();
  const hhName = `TestHousehold-${ts}`;

  const hh = await post(request, "/households", { name: hhName });
  const hhId = hh.id;

  const alice = await post(request, "/people", {
    firstName: "AliceE2E",
    lastName: `HHCurrent-${ts}`,
  });
  const bob = await post(request, "/people", {
    firstName: "BobE2E",
    lastName: `HHFormer-${ts}`,
  });
  const dave = await post(request, "/people", {
    firstName: "DaveE2E",
    lastName: `HHSubject-${ts}`,
  });

  await post(request, "/people-entity-roles", {
    personId: alice.id,
    entityType: "household",
    householdId: hhId,
    current: "current",
  });
  await post(request, "/people-entity-roles", {
    personId: bob.id,
    entityType: "household",
    householdId: hhId,
    current: "past",
  });
  await post(request, "/people-entity-roles", {
    personId: dave.id,
    entityType: "household",
    householdId: hhId,
    current: "current",
  });

  await page.goto(`/individuals/${dave.id}`);

  await expect(page.getByText("AliceE2E", { exact: false })).toBeVisible();
  await expect(page.getByText("BobE2E", { exact: false })).toBeVisible();

  const toggle = page.getByRole("button", { name: "Hide inactive" });
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect(page.getByText("AliceE2E", { exact: false })).toBeVisible();
  await expect(page.getByText("BobE2E", { exact: false })).not.toBeVisible();

  await page.getByRole("button", { name: "Show inactive" }).click();

  await expect(page.getByText("BobE2E", { exact: false })).toBeVisible();

  await post(request, `/people/${alice.id}/archive`, {});
  await post(request, `/people/${bob.id}/archive`, {});
  await post(request, `/people/${dave.id}/archive`, {});
  await post(request, `/households/${hhId}/archive`, {});
});

test("Edit household button navigates to the household detail page", async ({
  page,
  request,
}) => {
  const ts = Date.now();
  const hhName = `TestHousehold-${ts}`;

  const hh = await post(request, "/households", { name: hhName });
  const hhId = hh.id;

  const alice = await post(request, "/people", {
    firstName: "AliceE2E",
    lastName: `HHNav-${ts}`,
  });
  const dave = await post(request, "/people", {
    firstName: "DaveE2E",
    lastName: `HHNavSubject-${ts}`,
  });

  await post(request, "/people-entity-roles", {
    personId: alice.id,
    entityType: "household",
    householdId: hhId,
    current: "current",
  });
  await post(request, "/people-entity-roles", {
    personId: dave.id,
    entityType: "household",
    householdId: hhId,
    current: "current",
  });

  await page.goto(`/individuals/${dave.id}`);

  const editLink = page.getByRole("link", { name: `Edit ${hhName}` });
  await expect(editLink).toBeVisible();
  await editLink.click();

  await expect(page).toHaveURL(new RegExp(`/households/${hhId}`));
  await expect(page.getByText(hhName, { exact: false }).first()).toBeVisible();

  await post(request, `/people/${dave.id}/archive`, {});
  await post(request, `/people/${alice.id}/archive`, {});
  await post(request, `/households/${hhId}/archive`, {});
});

test("person with no household shows no household section and no Edit button", async ({
  page,
  request,
}) => {
  const ts = Date.now();

  const carol = await post(request, "/people", {
    firstName: "CarolE2E",
    lastName: `NoHH-${ts}`,
  });

  await page.goto(`/individuals/${carol.id}`);

  await expect(
    page.getByRole("link", { name: /Edit .+household/i }),
  ).toHaveCount(0);

  const peopleCard = page.getByText("People").first();
  if (await peopleCard.isVisible()) {
    await expect(
      page.getByText(/no colleagues or household members/i),
    ).toBeVisible();
  }

  await post(request, `/people/${carol.id}/archive`, {});
});
