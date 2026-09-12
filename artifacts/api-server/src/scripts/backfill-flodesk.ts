/**
 * One-time backfill: seed the Flodesk segment with every newsletter-eligible
 * person already in the CRM.
 *
 *   pnpm --filter @workspace/api-server run backfill:flodesk
 *
 * The outbound Flodesk sync only fires when a person is created or edited, so
 * the thousands of people already in the CRM won't appear in Flodesk until
 * someone happens to touch them. This script iterates all newsletter-eligible
 * people (`newsletter` true, `unsubscribedToNewsletter` false) and pushes each
 * into the segment via the existing bulk-safe `syncPersonToFlodesk` helper.
 *
 * `syncPersonToFlodesk` never throws and re-checks the email + Flodesk state
 * per person, so this is a thin, idempotent loop:
 *   - eligible + usable email           → subscribed (upsert + add to segment)
 *   - eligible but Flodesk shows them
 *     already unsubscribed               → mirrored_unsubscribe (CRM updated)
 *   - no usable email                    → skipped_no_email
 *   - transient API failure              → error (counted, loop continues)
 *
 * It respects the "Flodesk unsubscribe wins" guardrail (never resurrects a
 * subscriber who unsubscribed in Flodesk) and is safe to re-run.
 *
 * Processed in batches with a bounded concurrency limiter for gentle rate
 * limiting against the shared Flodesk API. Fails loudly when the Flodesk API
 * key / segment id are not configured.
 *
 * Env overrides:
 *   FLODESK_BACKFILL_CONCURRENCY  parallel in-flight pushes, 1..10 (default: 3)
 */
import pLimit from "p-limit";
import { db } from "@workspace/db";
import { people } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isFlodeskConfigured } from "../lib/flodeskClient";
import {
  syncPersonToFlodesk,
  type FlodeskOutboundOutcome,
} from "../lib/flodeskSync";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    logger.warn({ name, raw }, "ignoring invalid env override");
    return fallback;
  }
  return Math.min(Math.max(Math.floor(n), min), max);
}

async function main(): Promise<void> {
  if (!isFlodeskConfigured()) {
    throw new Error(
      "Flodesk is not configured — set FLODESK_API_KEY and FLODESK_SEGMENT_ID before running the backfill.",
    );
  }

  const concurrency = intEnv("FLODESK_BACKFILL_CONCURRENCY", 3, 1, 10);

  // Eligible = newsletter on AND not unsubscribed. The usable-email check is
  // done per person inside syncPersonToFlodesk (counted as skipped_no_email).
  const targets = await db
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.newsletter, true),
        eq(people.unsubscribedToNewsletter, false),
      ),
    );

  if (targets.length === 0) {
    console.log("No newsletter-eligible people — nothing to backfill.");
    return;
  }

  console.log(
    `Found ${targets.length} newsletter-eligible people. Backfilling into Flodesk (concurrency ${concurrency})…`,
  );

  const counts: Record<FlodeskOutboundOutcome, number> = {
    subscribed: 0,
    unsubscribed: 0,
    mirrored_unsubscribe: 0,
    skipped_no_email: 0,
    skipped_not_configured: 0,
    error: 0,
  };

  const limit = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    targets.map((t) =>
      limit(async () => {
        const res = await syncPersonToFlodesk(t.id);
        counts[res.outcome] += 1;
        processed += 1;
        if (processed % 100 === 0) {
          process.stdout.write(`\r${processed}/${targets.length} processed…`);
        }
      }),
    ),
  );

  const summary = { total: targets.length, ...counts };
  logger.info({ summary }, "Flodesk backfill complete");
  console.log("\n" + JSON.stringify(summary, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Flodesk backfill failed");
    console.error("Flodesk backfill failed:", err);
    process.exit(1);
  });
