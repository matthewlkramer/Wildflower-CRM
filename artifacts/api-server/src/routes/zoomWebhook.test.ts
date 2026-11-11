import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import router, {
  ZOOM_WEBHOOK_PATH,
  hasValidZoomSignature,
  zoomValidationAnswer,
  type RequestWithRawBody,
} from "./zoomWebhook";

const SECRET = "test-secret-token";
const ENVS = ["ZOOM_FORWFCRM_EVENTSUB_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"];
let server: Server;
let url: string;

const sign = (timestamp: string, raw: string, secret = SECRET) =>
  `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
const now = () => String(Math.floor(Date.now() / 1000));

async function post(raw: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  // the same raw-body capture app.ts applies for this path
  app.use(express.json({ verify(req, _res, buf) { (req as RequestWithRawBody).rawBody = buf; } }));
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api${ZOOM_WEBHOOK_PATH}`;
});
afterAll(async () => {
  for (const name of ENVS) delete process.env[name];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  for (const name of ENVS) delete process.env[name];
  process.env.ZOOM_FORWFCRM_EVENTSUB_SECRET = SECRET;
});

describe("Zoom webhook", () => {
  it("answers 503 until the secret token is configured", async () => {
    delete process.env.ZOOM_FORWFCRM_EVENTSUB_SECRET;
    expect((await post(JSON.stringify({ event: "meeting.started" }))).status).toBe(503);
  });

  it("answers Zoom's endpoint validation challenge with the HMAC of the plain token", async () => {
    const result = await post(JSON.stringify({ event: "endpoint.url_validation", payload: { plainToken: "abc123" } }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      plainToken: "abc123",
      encryptedToken: createHmac("sha256", SECRET).update("abc123").digest("hex"),
    });
    expect(zoomValidationAnswer("abc123", SECRET)).toEqual(result.body);
  });

  it("acknowledges an event signed over the exact bytes Zoom sent", async () => {
    // spacing and key order differ from JSON.stringify: only the raw body verifies
    const raw = '{ "payload": {"object":{"id":"99"}},  "event":"recording.completed", "event_ts": 1 }';
    const timestamp = now();
    const result = await post(raw, { "x-zm-signature": sign(timestamp, raw), "x-zm-request-timestamp": timestamp });
    expect(result).toEqual({ status: 200, body: { received: true } });
  });

  it("refuses a missing, wrong or stale signature", async () => {
    const raw = JSON.stringify({ event: "meeting.ended" });
    const timestamp = now();
    expect((await post(raw)).status).toBe(401);
    expect((await post(raw, { "x-zm-signature": sign(timestamp, raw, "other"), "x-zm-request-timestamp": timestamp })).status).toBe(401);
    const old = String(Number(timestamp) - 3600);
    expect((await post(raw, { "x-zm-signature": sign(old, raw), "x-zm-request-timestamp": old })).status).toBe(401);
    expect(hasValidZoomSignature({ signature: sign(old, raw), timestamp: old }, Buffer.from(raw), SECRET, Number(old))).toBe(true);
  });

  it("refuses a body with no event name", async () => {
    expect((await post(JSON.stringify({ payload: {} }))).status).toBe(400);
  });
});
