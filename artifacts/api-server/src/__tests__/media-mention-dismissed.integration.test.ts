import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Guard: a DELETED (dismissed) media mention stays gone.
 *
 * `upsertArticle` in lib/mediaIngest.ts uses
 * `INSERT ... ON CONFLICT (url) DO UPDATE ... WHERE media_mentions.dismissed = false`
 * so a news re-sync of the same URL:
 *   - creates the row on first sight,
 *   - links additional entities onto a live row (append, no duplicates),
 *   - is a NOOP against a dismissed row — never resurrects it or appends
 *     new entity links to it.
 *
 * Calls upsertArticle directly against the DB (no HTTP, no GDELT).
 * Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `mediaspec_${Date.now()}`;
const URL_LIVE = `https://example.com/${RUN}/article`;
const ORG_A = `${RUN}_org_a`;
const ORG_B = `${RUN}_org_b`;
const PERSON_A = `${RUN}_person_a`;

const ARTICLE = {
  url: URL_LIVE,
  title: `Test article ${RUN}`,
  domain: "example.com",
  publicationDate: null as string | null,
};

type Db = typeof import("@workspace/db");
type Ingest = typeof import("../lib/mediaIngest");

let db: Db["db"];
let mediaMentions: Db["mediaMentions"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let upsertArticle: Ingest["upsertArticle"];

async function loadRow() {
  const rows = await db
    .select()
    .from(mediaMentions)
    .where(eqFn(mediaMentions.url, URL_LIVE));
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const ingest = await import("../lib/mediaIngest");
  db = dbMod.db;
  mediaMentions = dbMod.mediaMentions;
  eqFn = drizzle.eq;
  upsertArticle = ingest.upsertArticle;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db.delete(mediaMentions).where(eqFn(mediaMentions.url, URL_LIVE));
}, 60_000);

describe.skipIf(!HAS_DB)("media mention dismissal vs news sync", () => {
  it("creates on first sight, links new entities, and no-ops on repeats", async () => {
    expect(
      await upsertArticle({ kind: "organization", id: ORG_A, name: "Org A" }, ARTICLE),
    ).toBe("created");
    // Same URL, different entity → linked (appended).
    expect(
      await upsertArticle({ kind: "person", id: PERSON_A, name: "Person A" }, ARTICLE),
    ).toBe("linked");
    // Same entity again → noop, no duplicate id in the array.
    expect(
      await upsertArticle({ kind: "organization", id: ORG_A, name: "Org A" }, ARTICLE),
    ).toBe("noop");

    const row = await loadRow();
    expect(row.organizationIds).toEqual([ORG_A]);
    expect(row.personIds).toEqual([PERSON_A]);
    expect(row.dismissed).toBe(false);
  }, 30_000);

  it("a dismissed mention is NOT resurrected or re-linked by a later sync", async () => {
    await db
      .update(mediaMentions)
      .set({ dismissed: true })
      .where(eqFn(mediaMentions.url, URL_LIVE));

    // Re-sync of an already-linked entity and of a brand-new entity: both noop.
    expect(
      await upsertArticle({ kind: "organization", id: ORG_A, name: "Org A" }, ARTICLE),
    ).toBe("noop");
    expect(
      await upsertArticle({ kind: "organization", id: ORG_B, name: "Org B" }, ARTICLE),
    ).toBe("noop");

    const row = await loadRow();
    expect(row.dismissed).toBe(true);
    expect(row.organizationIds).toEqual([ORG_A]); // ORG_B was NOT appended
    expect(row.personIds).toEqual([PERSON_A]);
  }, 30_000);
});
