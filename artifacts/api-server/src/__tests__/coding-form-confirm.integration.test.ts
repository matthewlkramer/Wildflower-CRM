import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Integration coverage for the coding-form link-approval endpoints:
 *
 *   POST /coding-form-rows/:id/confirm-match   — approve ONE row's proposed
 *     link as-is (stamps matchConfirmedAt WITHOUT rewriting the proposal or
 *     its auto provenance; 409 when the row has no donor).
 *
 *   POST /coding-form-rows/confirm-matched     — bulk-approve every
 *     still-pending, never-confirmed row with BOTH a donor AND a matched
 *     gift; never touches confirmed / applied / skipped rows. Idempotent.
 *
 * Donor / gift ids on coding_form_rows are plain text (staging convention —
 * no FKs), so rows can be seeded without seeding donors or gifts. All rows
 * are seeded with matchMethod set so the list-time auto-rematch never fires.
 *
 * The only seam mocked is requireAuth. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `cfr_confirm_${Date.now()}`;

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
let schema: {
  users: Db["users"];
  codingFormRows: Db["codingFormRows"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let server: Server;
let baseUrl = "";

const ADMIN_ID = `${RUN}_admin`;
const NON_ADMIN_ID = `${RUN}_member`;

// Seeded row ids (deterministic `<RUN>_<tag>`).
const ROW = {
  donorAndGift: `${RUN}_donor_gift`, // bulk target: pending, unconfirmed, donor + gift
  donorOnly: `${RUN}_donor_only`, // per-row confirm target; bulk must SKIP (no gift)
  giftOnly: `${RUN}_gift_only`, // bulk must skip (no donor); per-row 409
  alreadyConfirmed: `${RUN}_confirmed`, // bulk must not touch (already confirmed)
  skipped: `${RUN}_skipped`, // bulk must not touch (status skipped)
  hubCircle: `${RUN}_hub_circle`, // regression: Hub circle → real regions query in crossChecksFor
} as const;

const FROZEN_CONFIRMED_AT = new Date("2026-01-01T00:00:00Z");

async function post(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function seedRow(
  id: string,
  index: number,
  over: Partial<import("@workspace/db").NewCodingFormRow>,
): import("@workspace/db").NewCodingFormRow {
  return {
    id,
    source: "fy24",
    sourceRowIndex: 900000 + index, // far above any real import row
    rawData: {},
    donorNameRaw: `Test Donor ${id}`,
    // matchMethod set → the list/read-time auto-rematch never fires for these.
    matchMethod: "auto",
    matchTier: "high",
    status: "pending",
    ...over,
  };
}

async function loadRowDb(id: string) {
  const [r] = await db
    .select()
    .from(schema.codingFormRows)
    .where(eqFn(schema.codingFormRows.id, id));
  return r ?? null;
}

beforeAll(async () => {
  if (!HAS_DB) return;

  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = { users: dbMod.users, codingFormRows: dbMod.codingFormRows };
  eqFn = drizzle.eq;
  likeFn = drizzle.like;

  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: NON_ADMIN_ID,
      clerkId: `clerk_${NON_ADMIN_ID}`,
      email: `${NON_ADMIN_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);

  await db.insert(schema.codingFormRows).values([
    seedRow(ROW.donorAndGift, 1, {
      organizationId: `${RUN}_org`,
      matchedGiftId: `${RUN}_gift_a`,
    }),
    seedRow(ROW.donorOnly, 2, {
      individualGiverPersonId: `${RUN}_person`,
      matchedGiftId: null,
    }),
    seedRow(ROW.giftOnly, 3, {
      matchedGiftId: `${RUN}_gift_b`,
    }),
    seedRow(ROW.alreadyConfirmed, 4, {
      householdId: `${RUN}_household`,
      matchedGiftId: `${RUN}_gift_c`,
      matchConfirmedAt: FROZEN_CONFIRMED_AT,
      matchConfirmedByUserId: ADMIN_ID,
    }),
    seedRow(ROW.skipped, 5, {
      organizationId: `${RUN}_org2`,
      matchedGiftId: `${RUN}_gift_d`,
      status: "skipped",
    }),
    // Regression (prod 500, 2026-07): a Hub circle makes crossChecksFor run a
    // real regions lookup; the old `= ANY(${jsArray}::text[])` interpolation
    // produced "malformed array literal" at runtime (invisible to typecheck).
    // Seeded under the per-run source so the list GET below is isolated.
    seedRow(ROW.hubCircle, 6, {
      source: RUN,
      circleRaw: "Hub: Colorado",
    }),
  ]);

  state.user = { id: ADMIN_ID, role: "admin" };

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
    .delete(schema.codingFormRows)
    .where(likeFn(schema.codingFormRows.id, `${RUN}%`));
  await db.delete(schema.users).where(eqFn(schema.users.id, ADMIN_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, NON_ADMIN_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[coding-form-confirm] skipped: no live DATABASE_URL");
  }
  state.user = { id: ADMIN_ID, role: "admin" };
});

describe.skipIf(!HAS_DB)("coding-form link approval (integration)", () => {
  it("403s both endpoints for a non-admin", async () => {
    state.user = { id: NON_ADMIN_ID, role: "team_member" };
    const one = await post(
      `/api/coding-form-rows/${ROW.donorOnly}/confirm-match`,
    );
    expect(one.status).toBe(403);
    const bulk = await post("/api/coding-form-rows/confirm-matched");
    expect(bulk.status).toBe(403);
  }, 30_000);

  it("404s confirm-match for a missing row", async () => {
    const { status } = await post(
      `/api/coding-form-rows/${RUN}_nonexistent/confirm-match`,
    );
    expect(status).toBe(404);
  }, 30_000);

  it("409s confirm-match when the row has no donor", async () => {
    const { status, json } = await post(
      `/api/coding-form-rows/${ROW.giftOnly}/confirm-match`,
    );
    expect(status).toBe(409);
    expect((json as { error: string }).error).toMatch(/no matched donor/i);
    const after = await loadRowDb(ROW.giftOnly);
    expect(after!.matchConfirmedAt).toBeNull();
  }, 30_000);

  it("confirm-match stamps confirmation WITHOUT rewriting the proposal", async () => {
    const { status, json } = await post(
      `/api/coding-form-rows/${ROW.donorOnly}/confirm-match`,
    );
    expect(status).toBe(200);
    const body = json as {
      matchConfirmedAt: string | null;
      matchMethod: string | null;
      matchTier: string | null;
    };
    expect(body.matchConfirmedAt).not.toBeNull();
    // Provenance preserved — NOT re-stamped as a manual match.
    expect(body.matchMethod).toBe("auto");
    expect(body.matchTier).toBe("high");

    const after = await loadRowDb(ROW.donorOnly);
    expect(after!.matchConfirmedAt).not.toBeNull();
    expect(after!.matchConfirmedByUserId).toBe(ADMIN_ID);
    expect(after!.individualGiverPersonId).toBe(`${RUN}_person`);
    expect(after!.status).toBe("pending"); // confirming a link ≠ applying the row

    // Reset for the bulk test below (donorOnly must be unconfirmed again so we
    // can prove bulk skips it for LACKING A GIFT, not for being confirmed).
    await db
      .update(schema.codingFormRows)
      .set({ matchConfirmedAt: null, matchConfirmedByUserId: null })
      .where(eqFn(schema.codingFormRows.id, ROW.donorOnly));
  }, 30_000);

  it("bulk confirm-matched only stamps pending+unconfirmed rows with donor AND gift, and is idempotent", async () => {
    // NOTE: scoped to this run's rows only via DB-state assertions — the
    // endpoint itself scans the whole table, so `confirmed` may exceed 1 if
    // the dev DB has other eligible rows; assert on OUR rows' state instead.
    const first = await post("/api/coding-form-rows/confirm-matched");
    expect(first.status).toBe(200);
    const summary = first.json as { scanned: number; confirmed: number };
    expect(summary.confirmed).toBeGreaterThanOrEqual(1);
    expect(summary.scanned).toBe(summary.confirmed);

    const target = await loadRowDb(ROW.donorAndGift);
    expect(target!.matchConfirmedAt).not.toBeNull();
    expect(target!.matchConfirmedByUserId).toBe(ADMIN_ID);
    expect(target!.status).toBe("pending"); // status untouched
    expect(target!.matchMethod).toBe("auto"); // provenance untouched

    const donorOnly = await loadRowDb(ROW.donorOnly);
    expect(donorOnly!.matchConfirmedAt).toBeNull(); // no gift → skipped

    const giftOnly = await loadRowDb(ROW.giftOnly);
    expect(giftOnly!.matchConfirmedAt).toBeNull(); // no donor → skipped

    const confirmed = await loadRowDb(ROW.alreadyConfirmed);
    expect(confirmed!.matchConfirmedAt!.getTime()).toBe(
      FROZEN_CONFIRMED_AT.getTime(), // pre-existing confirmation untouched
    );

    const skipped = await loadRowDb(ROW.skipped);
    expect(skipped!.matchConfirmedAt).toBeNull(); // non-pending → skipped

    // Idempotent: our rows produce nothing on a second pass.
    const second = await post("/api/coding-form-rows/confirm-matched");
    expect(second.status).toBe(200);
    const target2 = await loadRowDb(ROW.donorAndGift);
    expect(target2!.matchConfirmedAt!.getTime()).toBe(
      target!.matchConfirmedAt!.getTime(),
    );
  }, 30_000);

  it("serializes a Hub-circle row against the real DB (regions lookup regression)", async () => {
    // Regression for a prod-only 500: crossChecksFor ran
    // `regions.id = ANY(${jsArray}::text[])`, which typechecks but throws
    // "malformed array literal" at runtime. Listing a row whose circle maps to
    // a hub region exercises the real query (now inArray).
    //
    // The `source` query filter is an enum (fy24/fy25/fy26/girasol), so the
    // per-run source can't be filtered directly; the list orders by source ASC
    // and `cfr_confirm_*` sorts before every real source, so page 1 has it.
    const res = await fetch(
      `${baseUrl}/api/coding-form-rows?status=pending&limit=100`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        crossChecks: Array<{ attribute: string; sheetValue: string | null }>;
      }>;
    };
    const row = body.data.find((r) => r.id === ROW.hubCircle);
    expect(row).toBeDefined();
    const regional = row!.crossChecks.find(
      (c) => c.attribute === "regionalRestriction",
    );
    expect(regional).toBeDefined();
    expect(regional!.sheetValue).toMatch(/colorado/i);
  }, 30_000);
});
