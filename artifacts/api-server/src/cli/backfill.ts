import { backfillIntelForUser } from "../lib/gmailBackfill";
import { logger } from "../lib/logger";

/**
 * One-shot CLI to trigger the email-intelligence backfill for a single
 * user. Run via:
 *
 *   node ./dist/backfill.mjs <userId>
 *
 * `backfillIntelForUser` acquires the same `gmail` advisory lock the
 * scheduler uses, so this can't collide with an in-flight scheduler
 * tick on the same mailbox. Exits non-zero on lock contention or
 * backfill error.
 */
async function main(): Promise<void> {
  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: node backfill.mjs <userId>");
    process.exit(2);
  }
  const result = await backfillIntelForUser(userId);
  if (!result.ok) {
    logger.error({ userId, result }, "Backfill returned not-ok");
    process.exit(1);
  }
  logger.info(
    { userId, report: result.report },
    "Backfill complete (CLI)",
  );
  process.exit(0);
}

void main();
