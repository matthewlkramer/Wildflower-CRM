import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const ORIGINAL_IMPLEMENTER = process.env.FEEDBACK_IMPLEMENTER_USER_ID;
const OWNER_ID = `media_backfill_owner_${Date.now()}`;

const { currentUser, getStatus, startBackfill } = vi.hoisted(() => ({
  currentUser: { id: "staff", role: "team_member" },
  getStatus: vi.fn(),
  startBackfill: vi.fn(),
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { ...currentUser };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

vi.mock("../lib/mediaRelevanceBackfill", () => ({
  getMediaRelevanceBackfillStatus: getStatus,
  startMediaRelevanceBackfill: startBackfill,
}));

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

beforeEach(() => {
  delete process.env.FEEDBACK_IMPLEMENTER_USER_ID;
  currentUser.id = "staff";
  currentUser.role = "team_member";
  getStatus.mockReset().mockResolvedValue({
    running: false,
    total: 17_042,
    canonicalized: 17_042,
    scored: 0,
    unscored: 17_042,
    filtered: 0,
    pinned: 0,
    pinnedFiltered: 0,
    minScore: null,
    maxScore: null,
  });
  startBackfill.mockReset();
});

afterAll(async () => {
  if (ORIGINAL_IMPLEMENTER === undefined) {
    delete process.env.FEEDBACK_IMPLEMENTER_USER_ID;
  } else {
    process.env.FEEDBACK_IMPLEMENTER_USER_ID = ORIGINAL_IMPLEMENTER;
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("owner-gated historical media review", () => {
  it("keeps status admin-only", async () => {
    const response = await fetch(`${baseUrl}/api/admin/media-relevance-backfill`);
    expect(response.status).toBe(403);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("lets other admins inspect progress but not start the review", async () => {
    currentUser.id = "other_admin";
    currentUser.role = "admin";

    const status = await fetch(`${baseUrl}/api/admin/media-relevance-backfill`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      canRun: false,
      total: 17_042,
      unscored: 17_042,
    });

    const start = await fetch(`${baseUrl}/api/admin/media-relevance-backfill`, {
      method: "POST",
    });
    expect(start.status).toBe(403);
    expect(startBackfill).not.toHaveBeenCalled();
  });

  it("allows only the configured implementation owner to start or resume", async () => {
    currentUser.id = OWNER_ID;
    currentUser.role = "admin";
    process.env.FEEDBACK_IMPLEMENTER_USER_ID = OWNER_ID;
    startBackfill.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const status = await fetch(`${baseUrl}/api/admin/media-relevance-backfill`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ canRun: true });

    const first = await fetch(`${baseUrl}/api/admin/media-relevance-backfill`, {
      method: "POST",
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ started: true });

    const duplicate = await fetch(
      `${baseUrl}/api/admin/media-relevance-backfill`,
      { method: "POST" },
    );
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ started: false });
    expect(startBackfill).toHaveBeenCalledTimes(2);
  });
});
