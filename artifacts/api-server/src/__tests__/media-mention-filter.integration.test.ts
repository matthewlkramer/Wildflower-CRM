import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `mediafilter_${Date.now()}`;
const PERSON_ID = `${RUN}_person`;
const IDS = [`${RUN}_visible`, `${RUN}_hidden`, `${RUN}_pinned`];

const { AUTH_USER_ID } = vi.hoisted(() => ({
  AUTH_USER_ID: `mediafilter_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: AUTH_USER_ID, role: "admin" };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let mediaMentions: (typeof import("@workspace/db"))["mediaMentions"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!HAS_DB) return;
  const schema = await import("@workspace/db");
  db = schema.db;
  mediaMentions = schema.mediaMentions;
  inArrayFn = (await import("drizzle-orm")).inArray;
  await db.insert(mediaMentions).values([
    {
      id: IDS[0],
      publicationName: "Relevant Press",
      title: "Relevant story",
      url: `https://example.org/${IDS[0]}`,
      relevanceScore: 0.9,
      isFiltered: false,
      personIds: [PERSON_ID],
    },
    {
      id: IDS[1],
      publicationName: "Noisy Press",
      title: "Likely namesake",
      url: `https://example.org/${IDS[1]}`,
      relevanceScore: 0.1,
      isFiltered: true,
      personIds: [PERSON_ID],
    },
    {
      id: IDS[2],
      publicationName: "Pinned Press",
      title: "Pinned namesake",
      url: `https://example.org/${IDS[2]}`,
      relevanceScore: 0.1,
      isFiltered: true,
      pinned: true,
      personIds: [PERSON_ID],
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
  await db.delete(mediaMentions).where(inArrayFn(mediaMentions.id, IDS));
}, 60_000);

async function list(includeFiltered = false) {
  const suffix = includeFiltered ? "&includeFiltered=true" : "";
  const response = await fetch(
    `${baseUrl}/api/media-mentions?personId=${PERSON_ID}${suffix}`,
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    data: Array<{ id: string; filtered: boolean; isFiltered?: boolean }>;
  }>;
}

describe.skipIf(!HAS_DB)("media mention relevance API", () => {
  it("hides filtered rows by default but always returns pinned rows", async () => {
    const response = await list();
    expect(response.data.map((row) => row.id).sort()).toEqual(
      [IDS[0], IDS[2]].sort(),
    );
    expect(response.data.every((row) => row.isFiltered === undefined)).toBe(
      true,
    );
    expect(response.data.find((row) => row.id === IDS[2])?.filtered).toBe(true);
  });

  it("returns every row when includeFiltered=true", async () => {
    const response = await list(true);
    expect(response.data.map((row) => row.id).sort()).toEqual([...IDS].sort());
  });
});
