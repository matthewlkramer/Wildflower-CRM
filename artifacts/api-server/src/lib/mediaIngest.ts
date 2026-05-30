import { db } from "@workspace/db";
import { funders, people } from "@workspace/db/schema";
import { inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import { searchGdelt } from "./gdelt";

/**
 * GDELT media-mention ingestion. For every funder and every high-capacity
 * individual we phrase-search recent news, dedupe by URL, and write/link a
 * `media_mentions` row. The same article can mention several entities, so we
 * upsert by URL and merge the entity id into the row's person/funder arrays
 * rather than creating duplicates.
 *
 * We intentionally do NOT AI-summarize: GDELT gives us the factual headline
 * (stored in `title`), and summarizing a headline alone risks fabricating
 * claims about a donor. `aiSummary` is left null for auto-ingested rows.
 */

// People at these giving-capacity tiers are worth monitoring individually.
const MONITORED_CAPACITY_TIERS = ["tier_250k_1m", "tier_1m_plus"] as const;

export interface IngestTarget {
  kind: "funder" | "person";
  id: string;
  name: string;
}

export interface IngestOptions {
  /** Lookback window per entity in days. */
  timespanDays?: number;
  /** Max articles requested per entity. */
  maxRecordsPerEntity?: number;
  /** Cap the number of entities processed this run (for verification/testing). */
  maxEntities?: number;
  /** Delay between GDELT calls to stay friendly with the free API. */
  throttleMs?: number;
}

export interface IngestSummary {
  entitiesProcessed: number;
  articlesSeen: number;
  mentionsCreated: number;
  mentionsLinked: number;
  errors: number;
}

/**
 * Best display name for a person: prefer the denormalized `fullName`, else
 * join first/last. Returns null when there's nothing searchable (we skip
 * those — a blank/one-token name produces useless, noisy results).
 */
export function personDisplayName(p: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string | null {
  const full = p.fullName?.trim();
  if (full) return full;
  const parts = [p.firstName?.trim(), p.lastName?.trim()].filter(
    (s): s is string => !!s,
  );
  // Require at least two tokens (first + last) — a lone first name is far too
  // noisy to phrase-search against global news.
  if (parts.length < 2) return null;
  return parts.join(" ");
}

/**
 * Pure helper: given an existing id array and an id, return the array with the
 * id appended if missing, or null when no change is needed. Keeps the
 * upsert-merge logic unit-testable without a DB.
 */
export function mergeEntityId(
  existing: string[] | null | undefined,
  id: string,
): string[] | null {
  const arr = existing ?? [];
  if (arr.includes(id)) return null;
  return [...arr, id];
}

/** Build the full target list: all funders + monitored-capacity people. */
export async function buildIngestTargets(): Promise<IngestTarget[]> {
  const [funderRows, personRows] = await Promise.all([
    db.select({ id: funders.id, name: funders.name }).from(funders),
    db
      .select({
        id: people.id,
        fullName: people.fullName,
        firstName: people.firstName,
        lastName: people.lastName,
      })
      .from(people)
      .where(inArray(people.capacityRating, [...MONITORED_CAPACITY_TIERS])),
  ]);

  const targets: IngestTarget[] = [];
  for (const f of funderRows) {
    const name = f.name?.trim();
    if (name) targets.push({ kind: "funder", id: f.id, name });
  }
  for (const p of personRows) {
    const name = personDisplayName(p);
    if (name) targets.push({ kind: "person", id: p.id, name });
  }
  return targets;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomically upsert a single article for one entity. Returns
 * "created" | "linked" | "noop".
 *
 * Uses `INSERT ... ON CONFLICT (url) DO UPDATE` so concurrent runs (the daily
 * scheduler + a manual trigger, or multiple instances) can't create duplicate
 * rows or clobber each other's entity-link merges — the dedupe + array-append
 * happen in a single statement under the unique index on `url`.
 *
 * The DO UPDATE merge only fires when the entity id is missing (the WHERE
 * guard), so an already-linked article returns no row → "noop". `xmax = 0`
 * distinguishes a fresh insert ("created") from an array merge ("linked").
 */
const ENTITY_COLUMN = {
  funder: "funder_ids",
  person: "person_ids",
} as const;

async function upsertArticle(
  target: IngestTarget,
  article: { url: string; title: string; domain: string; publicationDate: string | null },
): Promise<"created" | "linked" | "noop"> {
  // Column name comes from a fixed whitelist above — safe for sql.raw.
  const col = sql.raw(ENTITY_COLUMN[target.kind]);
  const result = await db.execute<{ inserted: boolean }>(sql`
    INSERT INTO media_mentions
      (id, publication_name, title, url, publication_date, source, ${col}, created_at, updated_at)
    VALUES (
      ${newId()},
      ${article.domain || "Unknown source"},
      ${article.title || null},
      ${article.url},
      ${article.publicationDate},
      'gdelt',
      ARRAY[${target.id}]::text[],
      now(), now()
    )
    ON CONFLICT (url) DO UPDATE SET
      ${col} = array_append(coalesce(media_mentions.${col}, '{}'::text[]), ${target.id}),
      updated_at = now()
    WHERE NOT (coalesce(media_mentions.${col}, '{}'::text[]) @> ARRAY[${target.id}]::text[])
    RETURNING (xmax = 0) AS inserted
  `);

  const row = result.rows[0];
  if (!row) return "noop";
  return row.inserted ? "created" : "linked";
}

/**
 * Run one ingestion pass. Never throws — per-entity errors are counted and
 * logged so a single failure can't abort the sweep.
 */
export async function ingestMediaMentions(
  opts: IngestOptions = {},
): Promise<IngestSummary> {
  const {
    timespanDays = 2,
    maxRecordsPerEntity = 25,
    maxEntities,
    throttleMs = 1500,
  } = opts;

  const allTargets = await buildIngestTargets();
  const targets =
    maxEntities != null ? allTargets.slice(0, maxEntities) : allTargets;

  const summary: IngestSummary = {
    entitiesProcessed: 0,
    articlesSeen: 0,
    mentionsCreated: 0,
    mentionsLinked: 0,
    errors: 0,
  };

  logger.info(
    { targetCount: targets.length, timespanDays, maxRecordsPerEntity },
    "Media ingestion run starting",
  );

  for (const target of targets) {
    try {
      const articles = await searchGdelt(target.name, {
        timespanDays,
        maxRecords: maxRecordsPerEntity,
      });
      summary.articlesSeen += articles.length;
      for (const article of articles) {
        const outcome = await upsertArticle(target, article);
        if (outcome === "created") summary.mentionsCreated += 1;
        else if (outcome === "linked") summary.mentionsLinked += 1;
      }
    } catch (err) {
      summary.errors += 1;
      logger.warn(
        { errClass: err instanceof Error ? err.name : typeof err, target: target.id },
        "Media ingestion entity failed",
      );
    }
    summary.entitiesProcessed += 1;
    if (throttleMs > 0) await sleep(throttleMs);
  }

  logger.info({ summary }, "Media ingestion run finished");
  return summary;
}
