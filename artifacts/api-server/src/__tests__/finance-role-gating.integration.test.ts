import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Integration coverage for the finance-role guard (workbench business rules
 * §6.2 / §7.3): only finance (or admin — admin ⊇ finance) users may change
 * accounting relationships or QuickBooks treatment.
 *
 * Strategy mirrors quickbooks-rules-admin.integration.test.ts: the only seam
 * mocked is requireAuth (injects req.appUser), the app runs against the real
 * dev DB. Gated endpoints are hit with NONEXISTENT ids:
 *   • team_member → must get 403 { error: "finance_role_required" } (guard
 *     fires before any lookup)
 *   • finance / admin → must get PAST the guard (any status except 403)
 * Non-gated review endpoints must NOT 403 for a team_member.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `fin_gate_${Date.now()}`;

const state = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: null as any,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = state.user;
    next();
  },
}));

type Db = typeof import("@workspace/db");

let db: Db["db"];
let usersTable: Db["users"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const ADMIN_ID = `${RUN}_admin`;
const FINANCE_ID = `${RUN}_finance`;
const MEMBER_ID = `${RUN}_member`;

async function post(
  path: string,
  body: unknown = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const NOPE = "nonexistent_id_xyz";

// Every finance-gated endpoint (path, body). Keep in sync with the inventory
// comment in src/lib/financeGuard.ts.
const GATED: Array<{ name: string; path: string; body?: unknown }> = [
  // Settlement links (payout ↔ QB deposit)
  {
    name: "confirmSettlementLink",
    path: `/api/reconciliation/settlement-links/${NOPE}/confirm`,
  },
  {
    name: "rejectSettlementProposal",
    path: `/api/reconciliation/settlement-links/${NOPE}/reject`,
  },
  {
    name: "confirmReconciliationBundle",
    path: `/api/reconciliation/bundle-proposals/${NOPE}/confirm`,
  },
  {
    name: "confirmBundleCrossProcessorTies",
    path: `/api/reconciliation/bundles/${NOPE}/confirm-ties`,
  },
  {
    name: "confirmStripePayoutExclude",
    path: `/api/stripe-payouts/${NOPE}/confirm-exclude`,
  },
  {
    name: "confirmStripePayoutKeep",
    path: `/api/stripe-payouts/${NOPE}/confirm-keep`,
  },
  {
    name: "confirmStripePayoutReplace",
    path: `/api/stripe-payouts/${NOPE}/confirm-replace`,
  },
  {
    name: "revertStripePayoutReconciliation",
    path: `/api/stripe-payouts/${NOPE}/revert-reconciliation`,
  },
  // Charge ↔ QB ties
  {
    name: "confirmPayoutChargeTies",
    path: `/api/reconciliation/payouts/${NOPE}/charge-ties/confirm`,
  },
  {
    name: "rejectChargeQbTie",
    path: `/api/reconciliation/charges/${NOPE}/qb-tie/reject`,
  },
  {
    name: "revertChargeQbTie",
    path: `/api/reconciliation/charges/${NOPE}/qb-tie/revert`,
  },
  // QuickBooks treatment on staged payments
  {
    name: "excludeStagedPayment",
    path: `/api/staged-payments/${NOPE}/exclude`,
    body: { reason: "not_a_gift" },
  },
  {
    name: "reIncludeStagedPayment",
    path: `/api/staged-payments/${NOPE}/re-include`,
  },
  {
    name: "setStagedPaymentCoding",
    path: `/api/staged-payments/${NOPE}/set-coding`,
    body: { objectCode: "4010" },
  },
  // NOTE: /staged-payments/group is retired (410 tombstone, ungated) — group
  // creation is gone (docs/adr-linear-money-model.md); only the live ungroup
  // action on legacy groups remains finance-gated.
  {
    name: "ungroupStagedPayments",
    path: `/api/staged-payments/ungroup`,
    body: { stagedPaymentIds: [`${NOPE}_a`] },
  },
];

// Non-accounting review actions that must stay open to every team member
// (§7.3 non-finance list): donor identification, CRM gift create/link,
// Stripe-charge evidence review, Donorbox review, bundle drafting.
const OPEN: Array<{ name: string; path: string; body?: unknown }> = [
  {
    name: "resolveStagedPayment (donor identification)",
    path: `/api/staged-payments/${NOPE}/resolve`,
    body: { organizationId: NOPE },
  },
  {
    name: "setStagedPaymentEntity",
    path: `/api/staged-payments/${NOPE}/set-entity`,
    body: { entityId: null },
  },
  {
    name: "unmatchStagedPayment (CRM-side link)",
    path: `/api/staged-payments/${NOPE}/unmatch`,
  },
  {
    name: "revertStagedPayment (CRM-side link)",
    path: `/api/staged-payments/${NOPE}/revert`,
  },
  {
    name: "excludeStripeStagedCharge (evidence review)",
    path: `/api/stripe-staged-charges/${NOPE}/exclude`,
    body: { reason: "not_a_gift" },
  },
  {
    name: "reIncludeStripeStagedCharge (evidence review)",
    path: `/api/stripe-staged-charges/${NOPE}/re-include`,
  },
  {
    name: "assembleReconciliationBundle (proposing is open)",
    path: `/api/reconciliation/bundle-proposals`,
    body: { anchorId: NOPE },
  },
];

beforeAll(async () => {
  if (!HAS_DB) return;

  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  usersTable = dbMod.users;
  eqFn = drizzle.eq;

  await db.insert(usersTable).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: FINANCE_ID,
      clerkId: `clerk_${FINANCE_ID}`,
      email: `${FINANCE_ID}@wildflowerschools.org`,
      role: "finance",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: `${MEMBER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);

  state.user = { id: MEMBER_ID, role: "team_member" };

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of [ADMIN_ID, FINANCE_ID, MEMBER_ID]) {
    await db.delete(usersTable).where(eqFn(usersTable.id, id));
  }
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[finance-role-gating] skipped: no live DATABASE_URL");
  }
  state.user = { id: MEMBER_ID, role: "team_member" };
});

describe.skipIf(!HAS_DB)("finance-role gating (integration)", () => {
  it("returns 403 finance_role_required for a team_member on EVERY gated endpoint", async () => {
    state.user = { id: MEMBER_ID, role: "team_member" };
    for (const ep of GATED) {
      const res = await post(ep.path, ep.body ?? {});
      expect(res.status, `${ep.name} should 403 for team_member`).toBe(403);
      expect(
        (res.json as { error: string }).error,
        `${ep.name} reason code`,
      ).toBe("finance_role_required");
    }
  }, 60_000);

  it("lets a finance user PAST the guard on every gated endpoint", async () => {
    state.user = { id: FINANCE_ID, role: "finance" };
    for (const ep of GATED) {
      const res = await post(ep.path, ep.body ?? {});
      expect(res.status, `${ep.name} should not 403 for finance`).not.toBe(
        403,
      );
    }
  }, 120_000);

  it("lets an admin PAST the guard on every gated endpoint (admin ⊇ finance)", async () => {
    state.user = { id: ADMIN_ID, role: "admin" };
    for (const ep of GATED) {
      const res = await post(ep.path, ep.body ?? {});
      expect(res.status, `${ep.name} should not 403 for admin`).not.toBe(403);
    }
  }, 120_000);

  it("keeps non-accounting review actions open to team members", async () => {
    state.user = { id: MEMBER_ID, role: "team_member" };
    for (const ep of OPEN) {
      const res = await post(ep.path, ep.body ?? {});
      expect(res.status, `${ep.name} must stay open (no 403)`).not.toBe(403);
    }
  }, 120_000);

  it("exposes viewerCanManageAccounting on workbench-clusters per role", async () => {
    state.user = { id: MEMBER_ID, role: "team_member" };
    const asMember = await get("/api/reconciliation/workbench-clusters?limit=1");
    expect(asMember.status).toBe(200);
    expect(
      (asMember.json as { viewerCanManageAccounting: boolean })
        .viewerCanManageAccounting,
    ).toBe(false);

    state.user = { id: FINANCE_ID, role: "finance" };
    const asFinance = await get(
      "/api/reconciliation/workbench-clusters?limit=1",
    );
    expect(asFinance.status).toBe(200);
    expect(
      (asFinance.json as { viewerCanManageAccounting: boolean })
        .viewerCanManageAccounting,
    ).toBe(true);

    state.user = { id: ADMIN_ID, role: "admin" };
    const asAdmin = await get("/api/reconciliation/workbench-clusters?limit=1");
    expect(asAdmin.status).toBe(200);
    expect(
      (asAdmin.json as { viewerCanManageAccounting: boolean })
        .viewerCanManageAccounting,
    ).toBe(true);
  }, 60_000);
});
