import { logger } from "../lib/logger";
import { runMonthlyTaskRefreshIfDue } from "../lib/taskSuggestionScheduler";

/**
 * Manual trigger for the monthly task-suggestion refresh. Regenerates the
 * cached next-step for every non-low-priority entity whose suggestion has
 * gone stale (mode "refresh-pending"). Shares the same advisory lock +
 * run-state as the scheduled sweep.
 *
 *   pnpm --filter @workspace/api-server run refresh:task-suggestions
 *   pnpm --filter @workspace/api-server run refresh:task-suggestions -- --force
 *
 * `--force` bypasses the ~monthly throttle (otherwise a run within the last
 * 28 days is a no-op).
 */

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes("--force");
  const summary = await runMonthlyTaskRefreshIfDue(force ? { force: true } : {});
  if (summary === null) {
    logger.warn(
      "Refresh skipped — not yet due (use --force) or advisory lock contended",
    );
  } else {
    logger.info({ summary }, "Refresh complete");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "refresh-task-suggestions failed");
    process.exit(1);
  });
