import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clearPaymentApplicationsForRealm } from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the bulk confirm-matches endpoint
 * (POST /api/staged-payments/confirm-matches) — the "Confirm selected" action
 * used to clear the Auto-matched queue in one call.
 *
 * Asserts:
 *   - several auto-applied rows confirm in one call (status stays approved,
 *     matchConfirmedAt + matchConfirmedByUserId stamped, matchStatus=matched)
 *   - ids that are not in a confirmable state (no donor; already done; missing)
 *     are silently SKIPPED, not errors, and the rest still confirm
 *   - an empty / invalid body is rejected 400 (Zod minItems)
 *
 * Same seam as the group-reconcile suites: only the Clerk auth gate
 * (`requireAuth`) is mocked to inject a seeded test user; the DB update and its
 * eligibility predicate are the real production code. Skips automatically when
 * no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `qb_cm_test_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID };
    next();
  },
}));

const RUN = `qbcm_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  stagedPayments: Db["stagedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

async function api(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Seed a staged row. Defaults to an auto-applied approved row WITH a donor —
 * i.e. an "Auto-matched" queue card awaiting confirmation. Override via opts.
 */
async function seedStaged(
  label: string,
  opts: {
    status?: "pending" | "approved" | "rejected";
    autoApplied?: boolean;
    withDonor?: boolean;
    matchConfirmedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = `${RUN}_sp_${label}`;
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: label,
    amount: "100.00",
    status: opts.status ?? "approved",
    autoApplied: opts.autoApplied ?? true,
    matchConfirmedAt: opts.matchConfirmedAt ?? null,
    organizationId: (opts.withDonor ?? true) ? ORG_ID : null,
  });
  return id;
}

async function readStaged(id: string) {
  const [row] = await db
    .select()
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  return row;
}

async function seedGift(id: string, amount: string): Promise<string> {
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
  });
  return id;
}

async function seedLedgerRow(opts: {
  id: string;
  paymentId: string;
  giftId: string;
  amountApplied: string;
  matchMethod: "system" | "system_confirmed" | "human";
}): Promise<string> {
  await db.insert(schema.paymentApplications).values({
    id: opts.id,
    paymentId: opts.paymentId,
    giftId: opts.giftId,
    amountApplied: opts.amountApplied,
    evidenceSource: "quickbooks",
    matchMethod: opts.matchMethod,
    createdTheGift: false,
  });
  return opts.id;
}

async function readPaymentApplication(id: string) {
  const [row] = await db
    .select()
    .from(schema.paymentApplications)
    .where(eqFn(schema.paymentApplications.id, id));
  return row;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    stagedPayments: dbMod.stagedPayments,
    giftsAndPayments: dbMod.giftsAndPayments,
    paymentApplications: dbMod.paymentApplications,
  };
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `QB Confirm-Matches Test Org ${RUN}`,
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await clearPaymentApplicationsForRealm(REALM_ID);
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.realmId, REALM_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.organizationId, ORG_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[quickbooks-confirm-matches] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("QuickBooks bulk confirm-matches (integration)", () => {
  it("confirms several auto-applied matches in one call", async () => {
    const aId = await seedStaged("a");
    const bId = await seedStaged("b");

    const res = await api("/api/staged-payments/confirm-matches", {
      ids: [aId, bId],
    });

    expect(res.status).toBe(200);
    expect(res.json.requested).toBe(2);
    expect(new Set(res.json.confirmedIds)).toEqual(new Set([aId, bId]));

    for (const id of [aId, bId]) {
      const row = await readStaged(id);
      expect(row.status).toBe("approved");
      expect(row.matchStatus).toBe("matched");
      expect(row.matchConfirmedAt).not.toBeNull();
      expect(row.matchConfirmedByUserId).toBe(TEST_USER_ID);
    }
  }, 30_000);

  it("skips ids that aren't in a confirmable state but confirms the rest", async () => {
    const okId = await seedStaged("ok");
    // No donor → not confirmable (num_nonnulls(donor) = 0).
    const noDonorId = await seedStaged("nodonor", { withDonor: false });
    // Already confirmed/done (autoApplied=false) → not in the auto-matched set.
    const doneId = await seedStaged("done", {
      autoApplied: false,
      matchConfirmedAt: new Date(),
    });
    const missingId = `${RUN}_sp_missing`;

    const res = await api("/api/staged-payments/confirm-matches", {
      ids: [okId, noDonorId, doneId, missingId],
    });

    expect(res.status).toBe(200);
    expect(res.json.requested).toBe(4);
    expect(res.json.confirmedIds).toEqual([okId]);

    // The skipped rows are untouched (still unconfirmed where applicable).
    expect((await readStaged(noDonorId)).matchConfirmedAt).toBeNull();
  }, 30_000);

  it("counts duplicate submitted ids in `requested` but confirms each row once", async () => {
    const aId = await seedStaged("dup");

    const res = await api("/api/staged-payments/confirm-matches", {
      ids: [aId, aId, aId],
    });

    expect(res.status).toBe(200);
    // `requested` reflects the raw payload; the row is confirmed exactly once.
    expect(res.json.requested).toBe(3);
    expect(res.json.confirmedIds).toEqual([aId]);
  }, 30_000);

  it("promotes auto-applied (system) ledger rows to system_confirmed; leaves human rows untouched", async () => {
    if (!HAS_DB) return;
    const giftId = await seedGift(`${RUN}_g_promote`, "100.00");
    // An auto-matched card: worker wrote a 'system' ledger row.
    const sysStaged = await seedStaged("promote_sys");
    const sysPa = await seedLedgerRow({
      id: `${RUN}_pa_sys`,
      paymentId: sysStaged,
      giftId,
      amountApplied: "100.00",
      matchMethod: "system",
    });
    // Control: a human-method ledger row on a separate payment must NOT change.
    const humanStaged = await seedStaged("promote_human");
    const humanPa = await seedLedgerRow({
      id: `${RUN}_pa_human`,
      paymentId: humanStaged,
      giftId,
      amountApplied: "0.01",
      matchMethod: "human",
    });

    const res = await api("/api/staged-payments/confirm-matches", {
      ids: [sysStaged, humanStaged],
    });
    expect(res.status).toBe(200);

    const sysRow = await readPaymentApplication(sysPa);
    expect(sysRow.matchMethod).toBe("system_confirmed");
    expect(sysRow.confirmedByUserId).toBe(TEST_USER_ID);
    expect(sysRow.confirmedAt).not.toBeNull();

    const humanRow = await readPaymentApplication(humanPa);
    expect(humanRow.matchMethod).toBe("human");
    expect(humanRow.confirmedByUserId).toBeNull();
    expect(humanRow.confirmedAt).toBeNull();
  }, 30_000);

  it("rejects an empty id list with 400", async () => {
    const res = await api("/api/staged-payments/confirm-matches", { ids: [] });
    expect(res.status).toBe(400);
  }, 30_000);
});
