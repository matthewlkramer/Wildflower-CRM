import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const worker = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../lib/conferenceResearchN8n", () => ({
  runConferenceResearchN8nTick: worker.run,
}));

import router, {
  CONFERENCE_RESEARCH_INTEGRATION_PATH,
  hasValidConferenceResearchN8nToken,
} from "./conferenceResearchIntegration";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api${CONFERENCE_RESEARCH_INTEGRATION_PATH}`;
});

afterAll(async () => {
  delete process.env.CONFERENCE_RESEARCH_N8N_AUTH_TOKEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONFERENCE_RESEARCH_N8N_AUTH_TOKEN = "expected-secret";
  worker.run.mockResolvedValue({
    status: "idle",
    hasMore: false,
    alertRequired: false,
    eventsScanned: 1,
    windowsDue: 0,
    enqueueFailures: 0,
    contextInvalidated: 0,
    staleRequeued: 0,
    staleExhausted: 0,
    jobsAttempted: 0,
    completed: 0,
    retrying: 0,
    failed: 0,
    skipped: 0,
  });
});

function post(token?: string) {
  return fetch(baseUrl, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe("conference research n8n integration route", () => {
  it("fails closed when the dedicated token is not configured", async () => {
    delete process.env.CONFERENCE_RESEARCH_N8N_AUTH_TOKEN;
    const response = await post();
    expect(response.status).toBe(503);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("rejects missing and near-match bearer tokens", async () => {
    expect((await post()).status).toBe(401);
    expect((await post("expected-secrex")).status).toBe(401);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("uses a timing-safe bearer comparison", () => {
    const request = {
      get: (name: string) =>
        name.toLowerCase() === "authorization"
          ? "Bearer expected-secret"
          : undefined,
    };
    expect(hasValidConferenceResearchN8nToken(request as Request)).toBe(true);
  });

  it("runs one bounded queue step for an authorized request", async () => {
    const response = await post("expected-secret");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "idle",
      hasMore: false,
    });
    expect(worker.run).toHaveBeenCalledOnce();
  });

  it("returns accepted while another worker owns the queue lock", async () => {
    worker.run.mockResolvedValue({
      status: "busy",
      hasMore: true,
      alertRequired: false,
      eventsScanned: 0,
      windowsDue: 0,
      enqueueFailures: 0,
      contextInvalidated: 0,
      staleRequeued: 0,
      staleExhausted: 0,
      jobsAttempted: 0,
      completed: 0,
      retrying: 0,
      failed: 0,
      skipped: 0,
    });
    expect((await post("expected-secret")).status).toBe(202);
  });
});
