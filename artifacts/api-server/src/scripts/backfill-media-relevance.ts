/**
 * Run manually on staging first; requires human sign-off before production.
 *
 * Resumable media relevance backfill. It evaluates rows whose
 * relevance_score is null in batches of 100. This file is a standalone
 * command and is intentionally not imported by application startup.
 */
import { logger } from "../lib/logger";
import { runMediaRelevanceBackfillWithLock } from "../lib/mediaRelevanceBackfill";

runMediaRelevanceBackfillWithLock()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "media relevance backfill failed");
    process.exit(1);
  });
