import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Gift-side splitting is RETIRED (ADR linear-money-model, Option B): one
 * QuickBooks staged row is never divided across several gifts. A deposit that
 * bundles several money events is divided EVIDENCE-side with
 * POST /reconciliation/staged-payments/:id/split-units (children sum exactly to
 * the parent), then each child unit is matched to its own gift through the
 * normal flows.
 *
 * The old endpoint remains registered solely as a tombstone so stale clients
 * get a self-explanatory error instead of a generic 404. This suite pins that
 * contract: always 410, error `gift_side_split_retired`, and no other verb.
 *
 * Skips automatically when no real DATABASE_URL is configured (importing the
 * app initializes the DB pool).
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

// The tombstone sits behind the same auth gate as the live routes; inject a
// fake user so the request reaches the handler.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: "qb_split_tombstone_user" };
    next();
  },
}));

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!HAS_DB) return;
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
}, 60_000);

describe.skipIf(!HAS_DB)(
  "POST /staged-payments/:id/split tombstone (integration)",
  () => {
    it("returns 410 gift_side_split_retired without touching anything", async () => {
      const res = await fetch(
        `${baseUrl}/api/staged-payments/any-id-at-all/split`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ giftIds: ["gift_a", "gift_b"] }),
        },
      );
      const json = (await res.json()) as { error?: string; message?: string };

      expect(res.status).toBe(410);
      expect(json.error).toBe("gift_side_split_retired");
      // The message must point the caller at the evidence-side replacement.
      expect(json.message).toMatch(/split/i);
      expect(json.message).toMatch(/unit/i);
    }, 30_000);
  },
);
