import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `media_quality_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PERSON_ID = `${RUN}_person`;
const KEEP_ID = `${RUN}_keep`;
const DUPLICATE_ID = `${RUN}_duplicate`;
const WRONG_PERSON_ID = `${RUN}_wrong_person`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: USER_ID, role: "team_member" };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

type DbModule = typeof import("@workspace/db");
let db: DbModule["db"];
let schema: DbModule;
let drizzle: typeof import("drizzle-orm");
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  drizzle = await import("drizzle-orm");
  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "team_member",
  });
  await db.insert(schema.people).values({
    id: PERSON_ID,
    fullName: "Scott Cook",
    ownerUserId: USER_ID,
  });
  await db.insert(schema.mediaMentions).values([
    {
      id: KEEP_ID,
      publicationName: "Example News",
      title: "Scott Cook announces a new philanthropic grant",
      publicationDate: "2026-09-01",
      url: `https://example.org/${RUN}/keep`,
      canonicalUrl: `https://example.org/${RUN}/keep`,
      headlineFingerprint: `${RUN}_same_headline`,
      source: "gdelt",
      personIds: [PERSON_ID],
      createdAt: new Date("2026-09-01T10:00:00Z"),
    },
    {
      id: DUPLICATE_ID,
      publicationName: "Syndicated News",
      title: "Scott Cook announces a new philanthropic grant",
      publicationDate: "2026-09-01",
      url: `https://example.net/${RUN}/repost`,
      canonicalUrl: `https://example.net/${RUN}/repost`,
      headlineFingerprint: `${RUN}_same_headline`,
      source: "gdelt",
      personIds: [PERSON_ID],
      createdAt: new Date("2026-09-01T11:00:00Z"),
    },
    {
      id: WRONG_PERSON_ID,
      publicationName: "Unrelated News",
      title: "Police seize contraband after traffic stop",
      publicationDate: "2026-09-02",
      url: `https://example.com/${RUN}/unrelated`,
      canonicalUrl: `https://example.com/${RUN}/unrelated`,
      headlineFingerprint: `${RUN}_unrelated`,
      source: "gdelt",
      personIds: [PERSON_ID],
      createdAt: new Date("2026-09-02T10:00:00Z"),
    },
  ]);
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(schema.mediaMentions)
    .where(
      drizzle.inArray(schema.mediaMentions.id, [
        KEEP_ID,
        DUPLICATE_ID,
        WRONG_PERSON_ID,
      ]),
    );
  await db.delete(schema.people).where(drizzle.eq(schema.people.id, PERSON_ID));
  await db.delete(schema.users).where(drizzle.eq(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("historical media quality view", () => {
  it("hides reposts and wrong-person matches by default without deleting them", async () => {
    const clean = await fetch(
      `${baseUrl}/api/media-mentions?personId=${PERSON_ID}&limit=20`,
    ).then((response) => response.json());
    expect(clean.data.map((row: { id: string }) => row.id)).toEqual([KEEP_ID]);
    expect(clean.pagination.total).toBe(1);
    expect(clean.hiddenCount).toBe(2);

    const all = await fetch(
      `${baseUrl}/api/media-mentions?personId=${PERSON_ID}&includeHidden=true&limit=20`,
    ).then((response) => response.json());
    expect(all.data.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining([KEEP_ID, DUPLICATE_ID, WRONG_PERSON_ID]),
    );
    expect(all.pagination.total).toBe(3);
    expect(all.hiddenCount).toBe(2);
  });
});
