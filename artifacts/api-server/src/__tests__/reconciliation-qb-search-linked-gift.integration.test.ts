import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the REVERSE picker on the reconciliation search: the
 * "Link gift/allocation to a payment" dialog (PaymentLinkDialog) searches QB
 * staged payments and must flag any payment that is ALREADY tied to a gift so
 * the UI can gray it + offer an unlink instead of a second (double-counting)
 * link. Endpoint: GET /api/reconciliation/qb-search.
 *
 * A staged payment is "already matched to a gift" exactly when any of its three
 * resolution pointers is set — matchedGiftId (linked to a pre-existing gift),
 * createdGiftId (minted), or groupReconciledGiftId (group member). That mirrors
 * the resolvedGift COALESCE the reconcile/revert service uses. These tests
 * assert searchQbStaged surfaces that as alreadyLinkedGiftId, and leaves an
 * unlinked payment's alreadyLinkedGiftId null.
 *
 * Same seam as the sibling reconciliation suites: only `requireAuth` is mocked
 * to inject a seeded admin user; the SQL and route validation are real
 * production code. Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_qbsearch_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `reconqbsearch_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;
// A distinctive payer name so the text search isolates only these rows.
const PAYER = `Zzqblink Payer ${RUN}`;
const GIFT_MATCHED_ID = `${RUN}_gift_matched`;
const GIFT_CREATED_ID = `${RUN}_gift_created`;
const STAGED_MATCHED_ID = `${RUN}_staged_matched`; // matchedGiftId set
const STAGED_CREATED_ID = `${RUN}_staged_created`; // createdGiftId set
const STAGED_FREE_ID = `${RUN}_staged_free`; // no gift link

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

type Candidate = {
  nodeType: string;
  id: string;
  label: string;
  alreadyLinkedGiftId?: string | null;
};

async function qbSearch(
  qs: string,
): Promise<{ status: number; json: { data?: Candidate[] } }> {
  const res = await fetch(`${baseUrl}/api/reconciliation/qb-search?${qs}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as { data?: Candidate[] } };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    stagedPayments: dbMod.stagedPayments,
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
    name: `Reconciliation QB Search Test Org ${RUN}`,
  });
  for (const id of [GIFT_MATCHED_ID, GIFT_CREATED_ID]) {
    await db.insert(schema.giftsAndPayments).values({
      id,
      organizationId: ORG_ID,
      ownerUserId: TEST_USER_ID,
      amount: "250.00",
      dateReceived: "2099-11-15",
    });
  }
  // Three staged payments sharing the distinctive payer name: one already tied
  // to a gift via matchedGiftId, one via createdGiftId, one with no gift link.
  await db.insert(schema.stagedPayments).values({
    id: STAGED_MATCHED_ID,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: STAGED_MATCHED_ID,
    qbLineId: "",
    amount: "250.00",
    dateReceived: "2099-11-15",
    payerName: PAYER,
    matchedGiftId: GIFT_MATCHED_ID,
  });
  await db.insert(schema.stagedPayments).values({
    id: STAGED_CREATED_ID,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: STAGED_CREATED_ID,
    qbLineId: "",
    amount: "250.00",
    dateReceived: "2099-11-15",
    payerName: PAYER,
    createdGiftId: GIFT_CREATED_ID,
  });
  await db.insert(schema.stagedPayments).values({
    id: STAGED_FREE_ID,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: STAGED_FREE_ID,
    qbLineId: "",
    amount: "250.00",
    dateReceived: "2099-11-15",
    payerName: PAYER,
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
  for (const id of [STAGED_MATCHED_ID, STAGED_CREATED_ID, STAGED_FREE_ID]) {
    await db
      .delete(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, id));
  }
  for (const id of [GIFT_MATCHED_ID, GIFT_CREATED_ID]) {
    await db
      .delete(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, id));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-qb-search-linked-gift] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "reconciliation qb-search already-linked-gift flag (integration)",
  () => {
    it("flags a QB payment matched to a pre-existing gift", async () => {
      const { status, json } = await qbSearch(`q=${encodeURIComponent(PAYER)}`);
      expect(status).toBe(200);
      const hit = (json.data ?? []).find((c) => c.id === STAGED_MATCHED_ID);
      expect(hit).toBeDefined();
      expect(hit!.nodeType).toBe("qb");
      expect(hit!.alreadyLinkedGiftId).toBe(GIFT_MATCHED_ID);
    });

    it("flags a QB payment that minted a gift (createdGiftId)", async () => {
      const { status, json } = await qbSearch(`q=${encodeURIComponent(PAYER)}`);
      expect(status).toBe(200);
      const hit = (json.data ?? []).find((c) => c.id === STAGED_CREATED_ID);
      expect(hit).toBeDefined();
      expect(hit!.alreadyLinkedGiftId).toBe(GIFT_CREATED_ID);
    });

    it("leaves an unlinked QB payment's alreadyLinkedGiftId null", async () => {
      const { status, json } = await qbSearch(`q=${encodeURIComponent(PAYER)}`);
      expect(status).toBe(200);
      const hit = (json.data ?? []).find((c) => c.id === STAGED_FREE_ID);
      expect(hit).toBeDefined();
      expect(hit!.alreadyLinkedGiftId ?? null).toBeNull();
    });
  },
);
