import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Live-DB coverage for the region hierarchy/grouping separation:
 *
 *   - deriveContainment walks BOTH edge sets (canonical parentage and
 *     region_memberships) recursively from a single derivation point;
 *   - expandRegionIdsForFilter returns the union used by containment-aware
 *     list filters;
 *   - wouldFinalGraphCycle blocks cycles in the intended FINAL graph,
 *     including cycles only formed by COMBINED parent+member changes;
 *   - GET /regions search matches aliases;
 *   - GET /regions/containment exposes the same derivation over HTTP;
 *   - POST /regions is admin-only and validates custom_region structure;
 *   - PATCH parentage cycle-rejection returns a validation error.
 *
 * The only seam mocked is the Clerk auth gate (requireAuth) — the injected
 * appUser's role is mutable so the same suite exercises both the admin and
 * non-admin paths of the genuine handlers. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { AUTH } = vi.hoisted(() => ({
  AUTH: { userId: `region_test_user_${Date.now()}`, role: "admin" },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: AUTH.userId, role: AUTH.role };
    next();
  },
}));

const RUN = `rgt${Date.now()}`;

// Seeded fixture ids (unique per run so parallel/dirty dev DBs never collide).
const COUNTRY = `${RUN}_country`;
const STATE_A = `${RUN}_state_a`;
const STATE_B = `${RUN}_state_b`;
const CITY = `${RUN}_city`;
const NEIGHBORHOOD = `${RUN}_neighborhood`;
const GROUPING = `${RUN}_grouping`; // multi_state_region ∋ STATE_A (membership)
const METRO = `${RUN}_metro`; // metro_area ∋ CITY (membership)
const ALIAS = `${RUN}_zetaville_alias`;

describe.skipIf(!HAS_DB)("region containment (live DB)", () => {
  let server: Server;
  let base: string;
  let db: (typeof import("@workspace/db"))["db"];
  let sql: (typeof import("drizzle-orm"))["sql"];
  let lib: typeof import("../lib/regionContainment");

  async function cleanup() {
    // Every seeded row (including POST-created ones, whose slugs start with
    // the run prefix) is reachable via the RUN prefix.
    await db.execute(sql`
      DELETE FROM region_memberships
      WHERE container_region_id IN (SELECT id FROM regions WHERE id LIKE ${`${RUN}%`})
         OR member_region_id IN (SELECT id FROM regions WHERE id LIKE ${`${RUN}%`})
    `);
    await db.execute(
      sql`DELETE FROM region_aliases WHERE region_id IN (SELECT id FROM regions WHERE id LIKE ${`${RUN}%`})`,
    );
    await db.execute(sql`DELETE FROM regions WHERE id LIKE ${`${RUN}%`}`);
  }

  beforeAll(async () => {
    ({ db } = await import("@workspace/db"));
    ({ sql } = await import("drizzle-orm"));
    lib = await import("../lib/regionContainment");

    await cleanup();

    // Canonical parentage: COUNTRY → {STATE_A, STATE_B} ; STATE_A → CITY →
    // NEIGHBORHOOD. Groupings sit OFF the parent chain: GROUPING (msr) has
    // membership → STATE_A; METRO has parent STATE_A and membership → CITY.
    const rows: Array<[string, string, string, string | null]> = [
      [COUNTRY, "Testland", "country", null],
      [STATE_A, "Alpha State", "state", COUNTRY],
      [STATE_B, "Beta State", "state", COUNTRY],
      [CITY, "Zetaville", "city", STATE_A],
      [NEIGHBORHOOD, "Old Quarter", "neighborhood", CITY],
      [GROUPING, "Greater Alpha Region", "multi_state_region", COUNTRY],
      [METRO, "Zeta Metro", "metro_area", STATE_A],
    ];
    for (const [id, name, type, parent] of rows) {
      await db.execute(sql`
        INSERT INTO regions (id, name, display_path, type, parent_region_id)
        VALUES (${id}, ${name}, ${name}, ${type}::region_type, ${parent})
      `);
    }
    await db.execute(sql`
      INSERT INTO region_memberships (id, container_region_id, member_region_id)
      VALUES (${`rm_${RUN}_1`}, ${GROUPING}, ${STATE_A}),
             (${`rm_${RUN}_2`}, ${METRO}, ${CITY})
    `);
    await db.execute(sql`
      INSERT INTO region_aliases (id, region_id, alias)
      VALUES (${`ra_${RUN}_1`}, ${CITY}, ${ALIAS})
    `);

    const { default: app } = await import("../app");
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    server?.close();
  }, 30_000);

  it("deriveContainment walks parentage edges recursively", async () => {
    const map = await lib.deriveContainment([STATE_A]);
    expect(new Set(map.get(STATE_A))).toEqual(
      new Set([CITY, NEIGHBORHOOD, METRO]),
    );
  }, 30_000);

  it("deriveContainment walks membership edges into parentage", async () => {
    // GROUPING contains STATE_A only via a membership edge; everything under
    // STATE_A must follow through canonical parentage.
    const map = await lib.deriveContainment([GROUPING]);
    expect(new Set(map.get(GROUPING))).toEqual(
      new Set([STATE_A, CITY, NEIGHBORHOOD, METRO]),
    );
  }, 30_000);

  it("deriveContainment yields empty arrays for leaves and unknown ids", async () => {
    const map = await lib.deriveContainment([NEIGHBORHOOD, "no_such_region"]);
    expect(map.get(NEIGHBORHOOD)).toEqual([]);
    expect(map.get("no_such_region")).toEqual([]);
  }, 30_000);

  it("expandRegionIdsForFilter unions roots with everything contained", async () => {
    const expanded = await lib.expandRegionIdsForFilter([GROUPING]);
    expect(new Set(expanded)).toEqual(
      new Set([GROUPING, STATE_A, CITY, NEIGHBORHOOD, METRO]),
    );
    // No expansion for a leaf: identity.
    expect(await lib.expandRegionIdsForFilter([STATE_B])).toEqual([STATE_B]);
    expect(await lib.expandRegionIdsForFilter([])).toEqual([]);
  }, 30_000);

  it("wouldFinalGraphCycle detects self, reverse-parent, and reverse-membership edges", async () => {
    // Self edges.
    expect(
      await lib.wouldFinalGraphCycle({ regionId: STATE_A, parentRegionId: STATE_A }),
    ).toBe(true);
    expect(
      await lib.wouldFinalGraphCycle({ regionId: STATE_A, memberRegionIds: [STATE_A] }),
    ).toBe(true);
    // CITY already sits inside STATE_A → STATE_A may not take CITY as parent,
    // and CITY may not take STATE_A as a member.
    expect(
      await lib.wouldFinalGraphCycle({ regionId: STATE_A, parentRegionId: CITY }),
    ).toBe(true);
    expect(
      await lib.wouldFinalGraphCycle({ regionId: CITY, memberRegionIds: [STATE_A] }),
    ).toBe(true);
    // GROUPING contains STATE_A via membership → STATE_A may not contain
    // GROUPING.
    expect(
      await lib.wouldFinalGraphCycle({ regionId: STATE_A, memberRegionIds: [GROUPING] }),
    ).toBe(true);
    // The safe direction stays allowed.
    expect(
      await lib.wouldFinalGraphCycle({ regionId: STATE_A, memberRegionIds: [STATE_B] }),
    ).toBe(false);
  }, 30_000);

  it("wouldFinalGraphCycle catches cycles only formed by COMBINED parent+member changes", async () => {
    // Neither edge alone is circular against pre-state: STATE_B does not
    // contain COUNTRY... but parent=STATE_B + member=STATE_B together create
    // STATE_B → X and X → STATE_B simultaneously.
    expect(
      await lib.wouldFinalGraphCycle({
        regionId: METRO,
        parentRegionId: STATE_B,
        memberRegionIds: [STATE_B],
      }),
    ).toBe(true);
    // Ancestor-of-parent as member: parent=CITY puts METRO under CITY; member
    // STATE_A contains CITY → METRO → STATE_A → CITY → METRO cycle.
    expect(
      await lib.wouldFinalGraphCycle({
        regionId: METRO,
        parentRegionId: CITY,
        memberRegionIds: [STATE_A],
      }),
    ).toBe(true);
    // Same combined shape without the back-edge is fine.
    expect(
      await lib.wouldFinalGraphCycle({
        regionId: METRO,
        parentRegionId: STATE_A,
        memberRegionIds: [STATE_B],
      }),
    ).toBe(false);
    // Replacement semantics: dropping the current circular-if-kept edge set
    // while adding the reverse edge is legal (STATE_B has no such edges, but
    // GROUPING → STATE_A does: replacing GROUPING's members with [] while
    // making it a child of STATE_A is NOT a cycle in the final graph).
    expect(
      await lib.wouldFinalGraphCycle({
        regionId: GROUPING,
        parentRegionId: STATE_A,
        memberRegionIds: [],
      }),
    ).toBe(false);
  }, 30_000);

  it("GET /regions matches alias search", async () => {
    AUTH.role = "admin";
    const res = await fetch(
      `${base}/api/regions?search=${encodeURIComponent(ALIAS)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; aliases: string[] }>;
    };
    expect(body.data.map((r) => r.id)).toContain(CITY);
    expect(body.data.find((r) => r.id === CITY)?.aliases).toContain(ALIAS);
  }, 30_000);

  it("GET /regions/containment returns the same derivation over HTTP", async () => {
    const res = await fetch(
      `${base}/api/regions/containment?ids=${GROUPING}&ids=${STATE_B}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ regionId: string; containedRegionIds: string[] }>;
    };
    const byId = new Map(body.data.map((d) => [d.regionId, d.containedRegionIds]));
    expect(new Set(byId.get(GROUPING))).toEqual(
      new Set([STATE_A, CITY, NEIGHBORHOOD, METRO]),
    );
    expect(byId.get(STATE_B)).toEqual([]);
  }, 30_000);

  it("GET /regions/containment accepts comma-joined ids (generated client shape)", async () => {
    // The Orval-generated client serializes array params as one comma-joined
    // value (?ids=a,b), not repeated params — the route must split it.
    const res = await fetch(
      `${base}/api/regions/containment?ids=${GROUPING},${STATE_B}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ regionId: string; containedRegionIds: string[] }>;
    };
    const byId = new Map(body.data.map((d) => [d.regionId, d.containedRegionIds]));
    expect(byId.size).toBe(2);
    expect(new Set(byId.get(GROUPING))).toEqual(
      new Set([STATE_A, CITY, NEIGHBORHOOD, METRO]),
    );
    expect(byId.get(STATE_B)).toEqual([]);
  }, 30_000);

  it("POST /regions is admin-only (403 for non-admins)", async () => {
    AUTH.role = "team_member";
    const res = await fetch(`${base}/api/regions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${RUN} Sneaky Region`, type: "custom_region" }),
    });
    expect(res.status).toBe(403);
    AUTH.role = "admin";
  }, 30_000);

  it("POST /regions rejects a custom_region without members or with a parent", async () => {
    AUTH.role = "admin";
    const noMembers = await fetch(`${base}/api/regions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${RUN} Empty Custom`, type: "custom_region" }),
    });
    expect(noMembers.status).toBe(400);

    const withParent = await fetch(`${base}/api/regions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `${RUN} Parented Custom`,
        type: "custom_region",
        parentRegionId: COUNTRY,
        memberRegionIds: [STATE_B],
      }),
    });
    expect(withParent.status).toBe(400);
  }, 30_000);

  it("POST /regions creates a custom_region grouping with members + aliases and a derived displayPath", async () => {
    AUTH.role = "admin";
    const res = await fetch(`${base}/api/regions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `${RUN} Focus Geography`,
        type: "custom_region",
        memberRegionIds: [STATE_B, CITY],
        aliases: [`${RUN}-focus`],
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      type: string;
      displayPath: string;
      memberRegionIds: string[];
      aliases: string[];
    };
    expect(created.type).toBe("custom_region");
    // Parentless grouping → displayPath is just its own name.
    expect(created.displayPath).toBe(`${RUN} Focus Geography`);
    expect(new Set(created.memberRegionIds)).toEqual(new Set([STATE_B, CITY]));
    expect(created.aliases).toContain(`${RUN}-focus`);

    // The new grouping participates in containment immediately.
    const map = await lib.deriveContainment([created.id]);
    expect(new Set(map.get(created.id))).toEqual(
      new Set([STATE_B, CITY, NEIGHBORHOOD]),
    );
  }, 30_000);

  it("PATCH /regions rejects a parent change that would create a cycle", async () => {
    AUTH.role = "admin";
    const res = await fetch(`${base}/api/regions/${STATE_A}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentRegionId: NEIGHBORHOOD }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message ?? "").toMatch(/cycle/i);
  }, 30_000);

  it("PATCH /regions rejects a COMBINED parent+member payload whose final graph is circular", async () => {
    AUTH.role = "admin";
    // Neither edge is circular against the pre-update graph (STATE_B and
    // METRO are unrelated), but applying both creates STATE_B → METRO
    // (parent) and METRO → STATE_B (membership) together.
    const res = await fetch(`${base}/api/regions/${METRO}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentRegionId: STATE_B,
        memberRegionIds: [STATE_B],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message ?? "").toMatch(/cycle/i);

    // Rejection is atomic — METRO's original edges are untouched.
    const fresh = await fetch(`${base}/api/regions/${METRO}`);
    const region = (await fresh.json()) as {
      parentRegionId: string | null;
      memberRegionIds: string[];
    };
    expect(region.parentRegionId).toBe(STATE_A);
    expect(region.memberRegionIds).toEqual([CITY]);
  }, 30_000);

  it("PATCH /regions rejects a member that contains the new parent (ancestor/member case)", async () => {
    AUTH.role = "admin";
    // parent=CITY nests METRO under CITY; member STATE_A contains CITY, so
    // the final graph loops METRO → STATE_A → CITY → METRO.
    const res = await fetch(`${base}/api/regions/${METRO}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentRegionId: CITY,
        memberRegionIds: [STATE_A],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message ?? "").toMatch(/cycle/i);
  }, 30_000);

  it("POST /regions rejects a create whose parent+member combination is circular", async () => {
    AUTH.role = "admin";
    // New region under STATE_B that claims COUNTRY (an ancestor of STATE_B)
    // as a member: new → COUNTRY → STATE_B → new.
    const res = await fetch(`${base}/api/regions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `${RUN} Circular Metro`,
        type: "metro_area",
        parentRegionId: STATE_B,
        memberRegionIds: [COUNTRY],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message ?? "").toMatch(/cycle/i);
  }, 30_000);

  it("PATCH /regions enforces custom_region shape on the MERGED final state", async () => {
    AUTH.role = "admin";
    // Create a valid grouping to mutate.
    const createRes = await fetch(`${base}/api/regions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `${RUN} Patchable Custom`,
        type: "custom_region",
        memberRegionIds: [STATE_B],
      }),
    });
    expect(createRes.status).toBe(201);
    const { id: customId } = (await createRes.json()) as { id: string };

    // Giving a grouping a parent is rejected.
    const withParent = await fetch(`${base}/api/regions/${customId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentRegionId: COUNTRY }),
    });
    expect(withParent.status).toBe(400);

    // Wiping its members is rejected.
    const noMembers = await fetch(`${base}/api/regions/${customId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberRegionIds: [] }),
    });
    expect(noMembers.status).toBe(400);

    // Retyping a parented region INTO custom_region is rejected too.
    const retype = await fetch(`${base}/api/regions/${METRO}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "custom_region" }),
    });
    expect(retype.status).toBe(400);

    // A valid member swap still works.
    const swap = await fetch(`${base}/api/regions/${customId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberRegionIds: [CITY] }),
    });
    expect(swap.status).toBe(200);
    const swapped = (await swap.json()) as { memberRegionIds: string[] };
    expect(swapped.memberRegionIds).toEqual([CITY]);
  }, 30_000);

  it("PATCH /regions parentage is admin-only (403 for non-admins)", async () => {
    AUTH.role = "team_member";
    const res = await fetch(`${base}/api/regions/${STATE_B}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentRegionId: null }),
    });
    expect(res.status).toBe(403);
    AUTH.role = "admin";
  }, 30_000);
});
