import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Derivation health check (GET /api/admin/derivation-health):
 *
 *  - seeds an opportunity whose STORED derived fields deliberately disagree
 *    with their derivation (loss_type='lost' but status='open' + a stale
 *    win_probability) and asserts the report flags exactly those fields;
 *  - seeds a clean opportunity and asserts it is NOT flagged;
 *  - asserts the check is REPORT-ONLY (stored values are untouched after it
 *    runs);
 *  - asserts the endpoint is admin-gated (403 for team_member).
 *
 * NOTE: quickbooks_tie_status is no longer a persisted column (Task #451) —
 * it is derived LIVE at query time. There is no stored value to drift, so
 * gift-level drift seeding / assertions are removed from this test.
 *
 * Only the Clerk auth gate (requireAuth) is mocked. Skips when no real
 * DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `derivhealth_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const MEMBER_ID = `${RUN}_member`;
const ORG_ID = `${RUN}_org`;
const DRIFT_OPP_ID = `${RUN}_opp_drift`;
const CLEAN_OPP_ID = `${RUN}_opp_clean`;
// Paid-rollup drift: stored `paid` disagrees with the live SUM of non-archived
// linked gifts (the write-off cap computes paid LIVE via pledgeCapacity.ts
// while the pre-close checklist reads the persisted rollup — this report entry
// is the tripwire that catches the two disagreeing).
const PAID_OPP_ID = `${RUN}_opp_paid`;
const PAID_GIFT_LIVE = `${RUN}_gift_live`;
const PAID_GIFT_ARCH = `${RUN}_gift_arch`;

const auth = vi.hoisted(() => ({
  current: { id: "", role: "" } as { id: string; role: string },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = auth.current;
    next();
  },
}));

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  giftsAndPayments: Db["giftsAndPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

interface DriftRow {
  table: string;
  id: string;
  field: string;
  stored: string | null;
  derived: string | null;
}
interface Report {
  driftCount: number;
  byField: Record<string, number>;
  drift: DriftRow[];
  checkedOpportunities: number;
}

async function getReport(): Promise<{ status: number; json: Report }> {
  const res = await fetch(`${baseUrl}/api/admin/derivation-health`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as Report };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    giftsAndPayments: dbMod.giftsAndPayments,
  };
  eqFn = drizzle.eq;

  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: `${MEMBER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `Deriv Health Org ${RUN}` });

  // DRIFT opp: loss_type='lost' means the derivation says status='lost',
  // stage keeps its funnel value, and canonical win_probability is 0.0000 —
  // but we store status='open' + wp 0.5000 as if a write path forgot its
  // applier call.
  await db.insert(schema.opportunitiesAndPledges).values({
    id: DRIFT_OPP_ID,
    name: `Deriv Health DRIFT Opp ${RUN}`,
    organizationId: ORG_ID,
    stage: "warm_lead",
    status: "open",
    lossType: "lost",
    winProbability: "0.5000",
  });

  // CLEAN opp: a plain open row at its stage weight — nothing to flag.
  await db.insert(schema.opportunitiesAndPledges).values({
    id: CLEAN_OPP_ID,
    name: `Deriv Health CLEAN Opp ${RUN}`,
    organizationId: ORG_ID,
    stage: "warm_lead",
    status: "open",
    lossType: null,
    winProbability: "0.1000",
    paid: "0",
  });

  // PAID-drift opp: one LIVE $500 gift + one ARCHIVED $250 gift are linked,
  // so the derived rollup is 500.00 — but we store paid='100' as if a write
  // path skipped the applier. The report must flag `paid` with derived=500
  // (proving the archived gift is EXCLUDED from the live sum too).
  await db.insert(schema.opportunitiesAndPledges).values({
    id: PAID_OPP_ID,
    name: `Deriv Health PAID Opp ${RUN}`,
    organizationId: ORG_ID,
    stage: "warm_lead",
    status: "open",
    winProbability: "0.1000",
    paid: "100",
  });
  await db.insert(schema.giftsAndPayments).values([
    {
      id: PAID_GIFT_LIVE,
      name: `Deriv Health live gift ${RUN}`,
      organizationId: ORG_ID,
      opportunityId: PAID_OPP_ID,
      amount: "500.00",
      dateReceived: "2099-11-01",
    },
    {
      id: PAID_GIFT_ARCH,
      name: `Deriv Health archived gift ${RUN}`,
      organizationId: ORG_ID,
      opportunityId: PAID_OPP_ID,
      amount: "250.00",
      dateReceived: "2099-11-02",
      archivedAt: new Date("2099-11-03T00:00:00Z"),
    },
  ]);

  auth.current = { id: ADMIN_ID, role: "admin" };

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
  for (const id of [PAID_GIFT_LIVE, PAID_GIFT_ARCH]) {
    await db
      .delete(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, id));
  }
  for (const id of [DRIFT_OPP_ID, CLEAN_OPP_ID, PAID_OPP_ID]) {
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, id));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  for (const id of [ADMIN_ID, MEMBER_ID]) {
    await db.delete(schema.users).where(eqFn(schema.users.id, id));
  }
}, 60_000);

describe.skipIf(!HAS_DB)("derivation health check", () => {
  it("flags the seeded opportunity drift (status + win_probability) and not the clean row", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await getReport();
    expect(status).toBe(200);
    expect(json.checkedOpportunities).toBeGreaterThanOrEqual(2);
    expect(json.driftCount).toBeGreaterThanOrEqual(2);

    // NOTE: json.drift is capped at 200 rows; opportunity drift is emitted
    // first, so on any realistically-sized test DB the seeded opp rows are
    // present. The gift assertion below goes through the compute fn directly
    // to stay independent of the cap.
    const mine = json.drift.filter((d) => d.id === DRIFT_OPP_ID);
    const fields = mine.map((d) => d.field).sort();
    expect(fields).toContain("status");
    expect(fields).toContain("win_probability");
    const statusRow = mine.find((d) => d.field === "status")!;
    expect(statusRow.stored).toBe("open");
    expect(statusRow.derived).toBe("lost");
    const wpRow = mine.find((d) => d.field === "win_probability")!;
    expect(Number(wpRow.stored)).toBeCloseTo(0.5);
    expect(Number(wpRow.derived)).toBeCloseTo(0);

    expect(json.drift.some((d) => d.id === CLEAN_OPP_ID)).toBe(false);
  });

  it("flags a stale persisted paid rollup (stored ≠ live gift sum; archived gifts excluded)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await getReport();
    expect(status).toBe(200);
    const mine = json.drift.filter((d) => d.id === PAID_OPP_ID);
    const paidRow = mine.find((d) => d.field === "paid");
    expect(paidRow).toBeTruthy();
    expect(Number(paidRow!.stored)).toBeCloseTo(100);
    // Derived = the LIVE $500 gift only — the archived $250 gift must not count.
    expect(Number(paidRow!.derived)).toBeCloseTo(500);
  });

  it("is report-only: stored values are untouched after a run", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    await getReport();
    const opp = await db
      .select({
        status: schema.opportunitiesAndPledges.status,
        winProbability: schema.opportunitiesAndPledges.winProbability,
      })
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, DRIFT_OPP_ID))
      .then((r) => r[0]);
    expect(opp?.status).toBe("open");
    expect(Number(opp?.winProbability)).toBeCloseTo(0.5);
  });

  it("rejects non-admins with 403", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const { status } = await getReport();
    expect(status).toBe(403);
  });
});
