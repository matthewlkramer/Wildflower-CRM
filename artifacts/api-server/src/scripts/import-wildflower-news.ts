import { readFile } from "node:fs/promises";
import path from "node:path";
import { importWildflowerNewsBatch, type WildflowerNewsBatchEntry } from "../lib/wildflowerNewsImport";
import { logger } from "../lib/logger";

async function main(): Promise<void> {
  const batchPath = process.argv[2];
  if (!batchPath) {
    throw new Error("Usage: pnpm --filter @workspace/api-server run import:wildflower-news -- <batch.json>");
  }
  const entries = JSON.parse(await readFile(batchPath, "utf8")) as WildflowerNewsBatchEntry[];
  if (!Array.isArray(entries)) throw new Error("Batch JSON must be an array of structured entries.");
  const summary = await importWildflowerNewsBatch(entries, {
    registerPath: path.resolve(
      process.cwd(),
      "../../docs/imports/wildflower-update-source-register.json",
    ),
  });
  logger.info({ summary }, "Wildflower news batch import complete");
}

main().then(() => process.exit(0)).catch((error) => {
  logger.error({ err: error }, "Wildflower news batch import failed");
  process.exit(1);
});