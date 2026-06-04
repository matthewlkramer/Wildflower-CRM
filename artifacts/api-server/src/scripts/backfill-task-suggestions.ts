import { logger } from "../lib/logger";
import { runTaskSuggestionBackfillIfDue } from "../lib/taskSuggestionBackfill";

/**
 * One-time upfront task-suggestion backfill. Ensures every non-low-priority
 * person + organization has a cached next-step suggestion ready (mode
 * "ensure" — idempotent + resumable, safe to re-run).
 *
 *   pnpm --filter @workspace/api-server run backfill:task-suggestions
 *   pnpm --filter @workspace/api-server run backfill:task-suggestions -- --max 50
 *
 * NOTE: in the dev sandbox a standalone tsx process can die partway through a
 * long sweep (same constraint as the email backfill). For a full production
 * run prefer the in-process trigger: write to /tmp/backfill-task-suggestions/
 * trigger and restart the API Server workflow (see index.ts). This script is
 * convenient for bounded verification runs (--max N).
 */

function parseMaxEntities(argv: string[]): number | undefined {
  const idx = argv.indexOf("--max");
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

async function main(): Promise<void> {
  const maxEntities = parseMaxEntities(process.argv.slice(2));
  const summary = await runTaskSuggestionBackfillIfDue(
    maxEntities != null ? { maxEntities } : {},
  );
  if (summary === null) {
    logger.warn("Backfill skipped — advisory lock contended (another sweep running)");
  } else {
    logger.info({ summary }, "Backfill complete");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "backfill-task-suggestions failed");
    process.exit(1);
  });
