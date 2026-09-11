/**
 * Run manually on staging first; requires human sign-off before production.
 *
 * Resumable media relevance backfill. It evaluates rows whose
 * relevance_score is null in batches of 100. This file is a standalone
 * command and is intentionally not imported by application startup.
 */
import { db } from "@workspace/db";
import { mediaMentions } from "@workspace/db/schema";
import { asc, eq, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  canonicalizeMediaArticleUrl,
  isMediaMentionFiltered,
  mediaRelevanceThreshold,
  scoreMediaRelevance,
} from "../lib/mediaRelevance";
import { loadPersonRelevanceTargets } from "../lib/mediaRelevanceTargets";

const BATCH_SIZE = 100;

async function main(): Promise<void> {
  let processed = 0;

  for (;;) {
    const batch = await db
      .select()
      .from(mediaMentions)
      .where(isNull(mediaMentions.relevanceScore))
      .orderBy(asc(mediaMentions.id))
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;

    const personIds = [...new Set(batch.flatMap((row) => row.personIds ?? []))];
    const people = await loadPersonRelevanceTargets(personIds);
    const personById = new Map(people.map((person) => [person.id, person]));
    const threshold = mediaRelevanceThreshold();

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

        await tx
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
          .where(eq(mediaMentions.id, row.id));
      }
    });

    processed += batch.length;
    logger.info(
      { processed, batchSize: batch.length },
      "media relevance backfill batch complete",
    );
  }

  logger.info({ processed }, "media relevance backfill complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "media relevance backfill failed");
    process.exit(1);
  });
