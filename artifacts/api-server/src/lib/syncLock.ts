import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Per-user per-source mutual exclusion for sync workers. Both the
 * in-process scheduler, the admin "Resync now" button, and the
 * per-user manual sync endpoints share the same workers — without a
 * lock, two overlapping invocations would read-modify-write the same
 * cursor row (last_history_id / sync_token / page_token) and could
 * leave the cursor inconsistent (skipped messages, stuck loops, or
 * 4xx from Google on the next call).
 *
 * Implementation: PostgreSQL session-level advisory locks. We take
 * a dedicated pool client, call pg_try_advisory_lock, run the work,
 * then unlock + release the client in `finally`. The lock is scoped
 * to (sourceTag, userIdHash) so Gmail and Calendar for the same
 * user can still run in parallel (they share the OAuth grant but
 * use different Google endpoints with separate quotas).
 *
 * We use `pg_try_advisory_lock` (non-blocking) rather than
 * `pg_advisory_lock` so contention returns `skipped: true` instead
 * of stacking up callers waiting on each other.
 */

type SyncSource = "gmail" | "calendar" | "quickbooks";

const SOURCE_TAG: Record<SyncSource, number> = {
  gmail: 1,
  calendar: 2,
  quickbooks: 3,
};

// Stable signed-int32 hash of a userId for pg_try_advisory_lock's
// (int4, int4) signature. djb2-ish — collisions are fine here since
// the source tag disambiguates the two channels and the lock is
// per-user-per-source. A spurious collision just means two unrelated
// users serialize through one source briefly, which is harmless.
function userIdInt32(userId: string): number {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) + h + userId.charCodeAt(i)) | 0;
  }
  // | 0 already coerces to int32; keep sign as-is — pg_*_advisory_lock
  // accepts negative int4 fine.
  return h;
}

export interface LockOutcome<T> {
  ran: boolean;
  result?: T;
}

export async function withSyncLock<T>(
  userId: string,
  source: SyncSource,
  fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const key1 = SOURCE_TAG[source];
  const key2 = userIdInt32(userId);
  const client = await pool.connect();
  try {
    const r = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [key1, key2],
    );
    const got = r.rows[0]?.pg_try_advisory_lock === true;
    if (!got) {
      logger.debug(
        { userId, source },
        "Sync lock contended — another worker is running, skipping",
      );
      return { ran: false };
    }
    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      // Best-effort unlock. If this throws (e.g. client died mid-run)
      // the lock is released automatically when the client is
      // released back to the pool with an error, since session-level
      // advisory locks are tied to the backend.
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          key1,
          key2,
        ]);
      } catch (err) {
        logger.warn({ err, userId, source }, "pg_advisory_unlock failed");
      }
    }
  } finally {
    client.release();
  }
}
