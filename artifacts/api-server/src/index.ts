import { readFileSync, unlinkSync, existsSync } from "node:fs";
import app from "./app";
import { logger } from "./lib/logger";
import { startSyncScheduler } from "./lib/syncScheduler";
import { backfillIntelForUser } from "./lib/gmailBackfill";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startSyncScheduler();

  // One-time email-intelligence backfill, triggered by writing a
  // userId to /tmp/backfill/trigger and restarting the workflow.
  // The trigger file is deleted on read so a subsequent restart
  // won't re-run. Kicked off in-process so the long-running scan
  // survives parent-shell teardown the way the standalone CLI
  // doesn't in this sandbox. Errors are logged but don't take the
  // server down.
  const triggerPath = "/tmp/backfill/trigger";
  if (existsSync(triggerPath)) {
    try {
      const backfillUser = readFileSync(triggerPath, "utf8").trim();
      unlinkSync(triggerPath);
      if (backfillUser) {
        logger.info({ userId: backfillUser }, "Backfill trigger file found — starting in-process backfill");
        void backfillIntelForUser(backfillUser).catch((err) => {
          logger.error({ err, userId: backfillUser }, "In-process backfill: failed");
        });
      }
    } catch (err) {
      logger.warn({ err, triggerPath }, "Failed to read backfill trigger");
    }
  }
});
