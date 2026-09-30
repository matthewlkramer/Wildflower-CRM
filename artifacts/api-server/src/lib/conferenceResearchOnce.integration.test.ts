import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { assertConferenceResearchSchemaReady } from "./conferenceResearchWorker";

describe("scheduled conference research schema preflight", () => {
  it("accepts the migrated test database without writing to it", async () => {
    await expect(assertConferenceResearchSchemaReady()).resolves.toBeUndefined();
  });

  it("allows only one session to hold the scheduled run lock", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const a = await first.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired", [13079, 267],
      );
      const b = await second.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired", [13079, 267],
      );
      expect(a.rows[0]?.acquired).toBe(true);
      expect(b.rows[0]?.acquired).toBe(false);
    } finally {
      await first.query("SELECT pg_advisory_unlock($1, $2)", [13079, 267]);
      first.release();
      second.release();
    }
  });
});