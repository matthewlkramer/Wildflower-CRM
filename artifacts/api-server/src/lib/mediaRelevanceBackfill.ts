import { db, pool } from "@workspace/db";
import { mediaMentions } from "@workspace/db/schema";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  canonicalizeMediaArticleUrl,
  isMediaMentionFiltered,
  mediaRelevanceThreshold,
  scoreMediaRelevance,
} from "./mediaRelevance";
import { loadPersonRelevanceTargets } from "./mediaRelevanceTargets";

const DEFAULT_BATCH_SIZE = 100;
const LOCK_KEY1 = 9_004;
const LOCK_KEY2 = 1;

let inFlight: Promise<void> | null = null;

export interface MediaRelevanceBackfillSummary {
  processed: number;
  batches: number;
}

export interface MediaRelevanceBackfillStatus {
  running: boolean;
  total: number;
  canonicalized: number;
  scored: number;
  unscored: number;
  filtered: number;
  pinned: number;
  pinnedFiltered: number;
  minScore: number | null;
  maxScore: number | null;
}

/**
 * Shared, resumable mutation boundary for historical media review.
 *
 * The standalone command and owner-gated admin action both call this function,
 * so live ingestion and retroactive review continue to use the same canonical
 * URL and relevance-score authorities. Rows are never deleted. A pinned row is
 * scored and canonicalized but its stored filtering decision is not changed.
 */
export async function runMediaRelevanceBackfill(
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<MediaRelevanceBackfillSummary> {
  let processed = 0;
  let batches = 0;

  for (;;) {
    const batch = await db
      .select()
      .from(mediaMentions)
      .where(isNull(mediaMentions.relevanceScore))
      .orderBy(asc(mediaMentions.id))
      .limit(batchSize);
    if (batch.length === 0) break;

    const personIds = [...new Set(batch.flatMap((row) => row.personIds ?? []))];
    const people = await loadPersonRelevanceTargets(personIds);
    const personById = new Map(people.map((person) => [person.id, person]));
    const threshold = mediaRelevanceThreshold();

    let batchProcessed = 0;
    await db.transaction(async (tx) => {
      for (const row of batch) {
        const article = {
          url: row.url,
          title: row.title ?? row.publicationName,
          domain: row.publicationName,
          publicationDate: row.publicationDate,
          snippet: row.aiSummary,
        };
        const scores = (row.personIds ?? [])
          .map((id) => personById.get(id))
          .filter((target): target is NonNullable<typeof target> => !!target)
          .map((target) => scoreMediaRelevance(target, article));
        // Organization searches are exact-name queries and retain their
        // historical visible behavior.
        if ((row.organizationIds?.length ?? 0) > 0) scores.push(1);
        const relevanceScore = scores.length ? Math.max(...scores) : 0;
        const shared = {
          canonicalUrl: canonicalizeMediaArticleUrl(article),
          relevanceScore,
          updatedAt: new Date(),
        };

        const updated = await tx
          .update(mediaMentions)
          .set(
            row.pinned
              ? shared
              : {
                  ...shared,
                  isFiltered: isMediaMentionFiltered(
                    relevanceScore,
                    false,
                    threshold,
                  ),
                },
          )
          .where(
            and(
              eq(mediaMentions.id, row.id),
              isNull(mediaMentions.relevanceScore),
            ),
          )
          .returning({ id: mediaMentions.id });
        batchProcessed += updated.length;
      }
    });

    processed += batchProcessed;
    batches += 1;
    logger.info(
      { processed, batchSize: batchProcessed, batches },
      "media relevance backfill batch complete",
    );
  }

  const summary = { processed, batches };
  logger.info({ ...summary }, "media relevance backfill complete");
  return summary;
}

/** Run at most one review across all app instances. */
export async function runMediaRelevanceBackfillWithLock(): Promise<
  MediaRelevanceBackfillSummary | null
> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (lock.rows[0]?.pg_try_advisory_lock !== true) {
      logger.info("Media relevance backfill lock contended; another run is active");
      return null;
    }
    try {
      return await runMediaRelevanceBackfill();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "Media relevance backfill advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Starts the guarded worker without holding the HTTP response open. The DB
 * lock handles clicks routed to another autoscale instance; this process-local
 * promise gives the initiating instance an immediate, useful status signal.
 */
export function startMediaRelevanceBackfill(): boolean {
  if (inFlight) return false;
  inFlight = runMediaRelevanceBackfillWithLock()
    .then(() => undefined)
    .catch((err) => {
      logger.error({ err }, "Owner-triggered media relevance backfill failed");
    })
    .finally(() => {
      inFlight = null;
    });
  return true;
}

export async function getMediaRelevanceBackfillStatus(): Promise<MediaRelevanceBackfillStatus> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      canonicalized: sql<number>`count(*) filter (where ${mediaMentions.canonicalUrl} is not null)::int`,
      scored: sql<number>`count(*) filter (where ${mediaMentions.relevanceScore} is not null)::int`,
      unscored: sql<number>`count(*) filter (where ${mediaMentions.relevanceScore} is null)::int`,
      filtered: sql<number>`count(*) filter (where ${mediaMentions.isFiltered} = true)::int`,
      pinned: sql<number>`count(*) filter (where ${mediaMentions.pinned} = true)::int`,
      pinnedFiltered: sql<number>`count(*) filter (where ${mediaMentions.pinned} = true and ${mediaMentions.isFiltered} = true)::int`,
      minScore: sql<number | null>`min(${mediaMentions.relevanceScore})`,
      maxScore: sql<number | null>`max(${mediaMentions.relevanceScore})`,
    })
    .from(mediaMentions);

  return {
    running: inFlight !== null,
    total: Number(row?.total ?? 0),
    canonicalized: Number(row?.canonicalized ?? 0),
    scored: Number(row?.scored ?? 0),
    unscored: Number(row?.unscored ?? 0),
    filtered: Number(row?.filtered ?? 0),
    pinned: Number(row?.pinned ?? 0),
    pinnedFiltered: Number(row?.pinnedFiltered ?? 0),
    minScore: row?.minScore == null ? null : Number(row.minScore),
    maxScore: row?.maxScore == null ? null : Number(row.maxScore),
  };
}
