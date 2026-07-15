import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Derivation health check (GET /api/admin/derivation-health + the underlying
 * runDerivationHealthCheck / computeGiftQbTieMany):
 *
 *  - seeds an opportunity whose STORED derived fields deliberately disagree
 *    with their derivation (loss_type='lost' but status='open' + a stale
 *    win_probability) and asserts the report flags exactly those fields;
 *  - seeds a clean opportunity and asserts it is NOT flagged;
 *  - seeds a gift stamped 'tied' with no cash-application ledger rows and
 *    asserts the shared compute path derives 'missing' (stored ≠ derived);
 *  - asserts the check is REPORT-ONLY (stored values are untouched after it
 *    runs);
 *  - asserts the endpoint is admin-gated (403 for team_member).
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
const DRIFT_GIFT_ID = `${RUN}_gift_drift`;

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
  checkedGifts: number;
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

  // DRIFT gift: stamped 'tied' but it has NO cash-application ledger rows
  // (and no allocations → not off-books), so the derivation says 'missing'.
  await db.insert(schema.giftsAndPayments).values({
    id: DRIFT_GIFT_ID,
    amount: "500.00",
    dateReceived: "2026-02-01",
    organizationId: ORG_ID,
    quickbooksTieStatus: "tied",
  });

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
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, DRIFT_GIFT_ID));
  for (const id of [DRIFT_OPP_ID, CLEAN_OPP_ID]) {
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

  it("derives 'missing' for the tied-with-no-ledger gift via the shared compute path", async () => {
    const { computeGiftQbTieMany } = await import("../lib/giftQbTie");
    const rows = await computeGiftQbTieMany([DRIFT_GIFT_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stored).toBe("tied");
    expect(rows[0]!.derived).toBe("missing");
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
    const gift = await db
      .select({ tie: schema.giftsAndPayments.quickbooksTieStatus })
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, DRIFT_GIFT_ID))
      .then((r) => r[0]);
    expect(gift?.tie).toBe("tied");
  });

  it("rejects non-admins with 403", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const { status } = await getReport();
    expect(status).toBe(403);
  });
});
