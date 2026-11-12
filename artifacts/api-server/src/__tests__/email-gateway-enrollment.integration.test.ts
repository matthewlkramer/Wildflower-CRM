import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inArray } from "drizzle-orm";
import { GMAIL_READ_SCOPE } from "../lib/googleOauth";

const hasDb = !!process.env.DATABASE_URL;
const run = `gateway-enrollment-${Date.now()}`;
const domain = "workspace.example";
const token = "test-only-email-gateway-token";
const email = (suffix: string) => `${run}-${suffix}@${domain}`;
const grants = [
  { name: "active", googleEmail: email("active").toUpperCase(), scope: GMAIL_READ_SCOPE },
  { name: "revoked", googleEmail: email("revoked"), revokedAt: new Date() },
  { name: "calendar", googleEmail: email("calendar"), scope: "https://www.googleapis.com/auth/calendar.readonly" },
  { name: "archived", googleEmail: email("archived"), archivedAt: new Date() },
  { name: "external", googleEmail: `${run}@outside.example` },
  { name: "duplicate1", googleEmail: email("duplicate") },
  { name: "duplicate2", googleEmail: email("duplicate") },
];

let schema: typeof import("@workspace/db/schema");
let db: typeof import("@workspace/db").db;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  if (!hasDb) return;
  vi.stubEnv("WFCRM_EMAIL_GATEWAY_TOKEN", token);
  vi.stubEnv("WFCRM_EMAIL_GATEWAY_WORKSPACE_DOMAIN", domain);
  schema = await import("@workspace/db/schema");
  ({ db } = await import("@workspace/db"));
  await db.insert(schema.users).values(grants.map(({ name, archivedAt }) => ({
    id: `${run}-${name}`,
    clerkId: `${run}-${name}`,
    email: email(`${name}-login`),
    displayName: name,
    role: "team_member" as const,
    archivedAt,
  })));
  await db.insert(schema.googleOauthTokens).values(grants.map((grant) => ({
    userId: `${run}-${grant.name}`,
    googleEmail: grant.googleEmail,
    accessTokenEnc: "synthetic-access",
    refreshTokenEnc: "synthetic-refresh",
    scope: grant.scope ?? GMAIL_READ_SCOPE,
    grantedAt: new Date(),
    revokedAt: grant.revokedAt,
  })));
  const { default: express } = await import("express");
  const { default: router } = await import("../routes/emailGatewayIntegration");
  const app = express();
  app.use("/api", router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/integrations/email-gateway`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (db) await db.delete(schema.users).where(inArray(schema.users.id, grants.map(({ name }) => `${run}-${name}`)));
});

describe.skipIf(!hasDb)("automatic Gmail tracking enrollment", () => {
  it("returns only work mailboxes with one active Gmail grant and requires the gateway token", async () => {
    const url = `${baseUrl}/connected-senders`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ senders: [email("active")] });
  });
});
