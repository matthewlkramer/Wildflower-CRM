import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ connect: vi.fn() }));
const research = vi.hoisted(() => ({
  assertSchemaReady: vi.fn(async () => {}),
  invalidateStale: vi.fn(async () => 0),
  enqueue: vi.fn(async () => ({
    eventsScanned: 1,
    windowsDue: 1,
    enqueueFailures: 0,
  })),
  recover: vi.fn(async () => ({ requeued: 0, exhausted: 0 })),
  runJob: vi.fn<() => Promise<"completed" | null>>(async () => "completed"),
}));

vi.mock("@workspace/db", () => ({ pool: { connect: database.connect } }));
vi.mock("./conferenceResearchWorker", () => ({
  assertConferenceResearchSchemaReady: research.assertSchemaReady,
  invalidateStaleActiveRequests: research.invalidateStale,
  enqueueScheduledResearch: research.enqueue,
  recoverExpiredConferenceResearchLeases: research.recover,
  runOneResearchJob: research.runJob,
}));

import { runConferenceResearchN8nTick } from "./conferenceResearchN8n";

function client(acquired: boolean) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired }] })
      .mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
}

describe("n8n conference research tick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    research.runJob.mockResolvedValue("completed");
  });

  it("returns busy without touching the queue when another worker owns the lock", async () => {
    const poolClient = client(false);
    database.connect.mockResolvedValue(poolClient);

    await expect(runConferenceResearchN8nTick()).resolves.toMatchObject({
      status: "busy",
      hasMore: true,
      alertRequired: false,
      jobsAttempted: 0,
    });
    expect(research.assertSchemaReady).not.toHaveBeenCalled();
    expect(poolClient.release).toHaveBeenCalledOnce();
  });

  it("processes at most one job and asks n8n for a final drain pass", async () => {
    const poolClient = client(true);
    database.connect.mockResolvedValue(poolClient);

    await expect(runConferenceResearchN8nTick()).resolves.toMatchObject({
      status: "processed",
      hasMore: true,
      alertRequired: false,
      eventsScanned: 1,
      windowsDue: 1,
      jobsAttempted: 1,
      completed: 1,
    });
    expect(research.runJob).toHaveBeenCalledOnce();
    expect(poolClient.query).toHaveBeenLastCalledWith(
      "SELECT pg_advisory_unlock($1, $2)",
      [13079, 267],
    );
    expect(poolClient.release).toHaveBeenCalledOnce();
  });

  it("reports an idle queue without requesting another call", async () => {
    const poolClient = client(true);
    database.connect.mockResolvedValue(poolClient);
    research.runJob.mockResolvedValue(null);

    await expect(runConferenceResearchN8nTick()).resolves.toMatchObject({
      status: "idle",
      hasMore: false,
      alertRequired: false,
      jobsAttempted: 0,
    });
  });
});
