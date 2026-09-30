import { describe, expect, it, vi } from "vitest";
import {
  runConferenceResearchOnce,
  type ConferenceRunDependencies,
} from "./conferenceResearchOnce";
import {
  ConferenceResearchSchemaNotReadyError,
  getDueConferenceResearchWindows,
  getResearchRetryDelayMs,
  requireConferenceResearchSchema,
  shouldStartConferenceResearchScheduler,
} from "./conferenceResearchWorker";

function dependencies(overrides: Partial<ConferenceRunDependencies> = {}): ConferenceRunDependencies {
  return {
    assertSchemaReady: vi.fn(async () => {}),
    invalidateStale: vi.fn(async () => 0),
    enqueue: vi.fn(async () => ({ eventsScanned: 0, windowsDue: 0, enqueueFailures: 0 })),
    recover: vi.fn(async () => ({ requeued: 0, exhausted: 0 })),
    runJob: vi.fn(async () => null),
    now: () => Date.parse("2026-09-30T06:15:00Z"),
    ...overrides,
  };
}

describe("scheduled conference research one-shot", () => {
  it("exits zero with no work, checking schema before any write", async () => {
    const order: string[] = [];
    const deps = dependencies({
      assertSchemaReady: async () => { order.push("schema"); },
      invalidateStale: async () => { order.push("invalidate"); return 0; },
      enqueue: async () => { order.push("enqueue"); return { eventsScanned: 1, windowsDue: 0, enqueueFailures: 0 }; },
      recover: async () => { order.push("recover"); return { requeued: 0, exhausted: 0 }; },
      runJob: async () => { order.push("claim"); return null; },
    });
    expect(await runConferenceResearchOnce(deps)).toMatchObject({
      eventsScanned: 1, jobsAttempted: 0, exitCode: 0, jobCapReached: false,
    });
    expect(order).toEqual(["schema", "invalidate", "enqueue", "recover", "claim"]);
  });

  it("catches up missing dates and both agenda windows on a delayed run", () => {
    const now = "2026-09-30";
    expect(getDueConferenceResearchWindows({ startDate: null }, now)).toEqual([
      { kind: "dates", windowKey: "dates_missing" },
    ]);
    expect(getDueConferenceResearchWindows({ startDate: "2026-10-01" }, now)).toEqual([
      { kind: "agenda_speakers", windowKey: "before_21_days:2026-10-01" },
      { kind: "agenda_speakers", windowKey: "before_2_days:2026-10-01" },
    ]);
    expect(getDueConferenceResearchWindows({ startDate: "2026-09-29" }, now)).toEqual([]);
  });

  it("reports stale leases and retryable failures as alert-worthy without retrying in a hot loop", async () => {
    const runJob = vi.fn().mockResolvedValueOnce("retry").mockResolvedValueOnce(null);
    const summary = await runConferenceResearchOnce(dependencies({
      invalidateStale: async () => 2,
      recover: async () => ({ requeued: 1, exhausted: 1 }),
      runJob,
    }));
    expect(summary).toMatchObject({ contextInvalidated: 2, staleRequeued: 1, staleExhausted: 1, retrying: 1, exitCode: 1 });
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(getResearchRetryDelayMs(1)).toBeGreaterThan(0);
  });

  it("handles overlapping invocations with a shared atomic claim and idempotent window", async () => {
    const windows = new Set<string>();
    const queue: string[] = [];
    const makeDeps = () => dependencies({
      enqueue: async () => {
        if (!windows.has("before_21_days:2026-10-01")) {
          windows.add("before_21_days:2026-10-01");
          queue.push("job");
        }
        return { eventsScanned: 1, windowsDue: 1, enqueueFailures: 0 };
      },
      runJob: async () => queue.shift() ? "completed" : null,
    });
    const runs = await Promise.all([runConferenceResearchOnce(makeDeps()), runConferenceResearchOnce(makeDeps())]);
    expect(runs.reduce((sum, run) => sum + run.completed, 0)).toBe(1);
    expect(runs.map((run) => run.exitCode)).toEqual([0, 0]);
  });

  it("respects both job and runtime caps, leaving work for the next run", async () => {
    const jobs = await runConferenceResearchOnce(dependencies({
      runJob: async () => "completed",
    }), { maxJobs: 2 });
    expect(jobs).toMatchObject({ jobsAttempted: 2, completed: 2, jobCapReached: true, exitCode: 0 });
    let clock = 0;
    const timed = await runConferenceResearchOnce(dependencies({
      now: () => clock,
      runJob: async () => { clock += 11; return "completed"; },
    }), { maxRuntimeMs: 10 });
    expect(timed).toMatchObject({ jobsAttempted: 1, runtimeCapReached: true, exitCode: 0 });
  });

  it("returns nonzero for enqueue/job failures and blocks all writes when schema is absent", async () => {
    const failure = await runConferenceResearchOnce(dependencies({
      enqueue: async () => ({ eventsScanned: 1, windowsDue: 1, enqueueFailures: 1 }),
      runJob: vi.fn().mockResolvedValueOnce("failed").mockResolvedValueOnce(null),
    }));
    expect(failure).toMatchObject({ enqueueFailures: 1, failed: 1, exitCode: 1 });
    const enqueue = vi.fn();
    await expect(runConferenceResearchOnce(dependencies({
      assertSchemaReady: async () => { throw new ConferenceResearchSchemaNotReadyError(); },
      enqueue,
    }))).rejects.toThrow("publish migration 0267");
    expect(enqueue).not.toHaveBeenCalled();
    expect(() => requireConferenceResearchSchema(false)).toThrow("publish migration 0267");
    expect(() => requireConferenceResearchSchema(true)).not.toThrow();
  });

  it("starts the interval only outside production", () => {
    expect(shouldStartConferenceResearchScheduler("production")).toBe(false);
    expect(shouldStartConferenceResearchScheduler("development")).toBe(true);
    expect(shouldStartConferenceResearchScheduler("test")).toBe(true);
  });
});