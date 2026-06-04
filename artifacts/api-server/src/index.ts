import { readFileSync, unlinkSync, existsSync } from "node:fs";
import app from "./app";
import { logger } from "./lib/logger";
import { startSyncScheduler } from "./lib/syncScheduler";
import { startMediaIngestScheduler } from "./lib/mediaIngestScheduler";
import { startTaskSuggestionScheduler } from "./lib/taskSuggestionScheduler";
import { runTaskSuggestionBackfillIfDue } from "./lib/taskSuggestionBackfill";
import { backfillIntelForUser } from "./lib/gmailBackfill";
import { analyzePendingForUser } from "./lib/analyzePending";

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
  startMediaIngestScheduler();
  startTaskSuggestionScheduler();

  // One-time upfront task-suggestion backfill: ensures every non-low-priority
  // person + organization has a cached next-step suggestion. Triggered by
  // writing to /tmp/backfill-task-suggestions/trigger and restarting the
  // workflow. Runs in-process (advisory-locked + resumable) so the long sweep
  // survives parent-shell teardown the way a standalone tsx script doesn't in
  // this sandbox. The trigger file is consumed on read so a later restart
  // won't re-run. Errors are logged but don't take the server down.
  const taskBackfillTriggerPath = "/tmp/backfill-task-suggestions/trigger";
  if (existsSync(taskBackfillTriggerPath)) {
    try {
      unlinkSync(taskBackfillTriggerPath);
      logger.info(
        "Task-suggestion backfill trigger found — starting in-process backfill",
      );
      void runTaskSuggestionBackfillIfDue()
        .then((summary) =>
          logger.info({ summary }, "Task-suggestion backfill complete"),
        )
        .catch((err) => {
          logger.error({ err }, "In-process task-suggestion backfill: failed");
        });
    } catch (err) {
      logger.warn(
        { err, triggerPath: taskBackfillTriggerPath },
        "Failed to read task-suggestion backfill trigger",
      );
    }
  }

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

  // One-time AI analysis sweep over a user's pending, not-yet-analyzed
  // proposals (Gmail-free phase D). Same trigger-file + restart pattern
  // as the backfill above: write a userId to /tmp/analyze-pending/trigger
  // and restart. Runs in-process for the same reasons the backfill does —
  // standalone tsx scripts die after ~10 rows and contend with the
  // scheduler's inline AI over the shared proxy. The file is consumed on
  // read so a later restart won't re-run.
  const analyzeTriggerPath = "/tmp/analyze-pending/trigger";
  if (existsSync(analyzeTriggerPath)) {
    try {
      const analyzeUser = readFileSync(analyzeTriggerPath, "utf8").trim();
      unlinkSync(analyzeTriggerPath);
      if (analyzeUser) {
        logger.info(
          { userId: analyzeUser },
          "Analyze-pending trigger file found — starting in-process sweep",
        );
        void analyzePendingForUser(analyzeUser)
          .then((r) =>
            logger.info({ userId: analyzeUser, ...r }, "analyze-pending complete"),
          )
          .catch((err) => {
            logger.error(
              { err, userId: analyzeUser },
              "In-process analyze-pending: failed",
            );
          });
      }
    } catch (err) {
      logger.warn(
        { err, triggerPath: analyzeTriggerPath },
        "Failed to read analyze-pending trigger",
      );
    }
  }
});
