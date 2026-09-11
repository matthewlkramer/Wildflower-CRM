import { db } from "@workspace/db";
import { organizations, people } from "@workspace/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import { searchGdelt } from "./gdelt";
import { enqueueTaskSuggestion } from "./taskSuggestionQueue";
import { createHash } from "node:crypto";

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

// Funder subtypes that are the philanthropic arm of a larger company/bank.
// For these we search the FOUNDATION specifically, never the parent
// corporation — searching e.g. "Wells Fargo" floods us with unrelated
// corporate/market news instead of grant activity.
const CORPORATE_FOUNDATION_SUBTYPES = [
  "corporate_foundation",
  "bank_foundation",
] as const;

// Tokens that mark a string as already naming a foundation / philanthropic
// arm (so we don't redundantly append "Foundation").
const FOUNDATION_MARKER = /foundation|fundaci[oó]n|\.org|philanthrop|\bfund\b/i;

export interface IngestTarget {
  kind: "organization" | "person";
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
 * Pure helper: derive the news-search name for a corporate/bank foundation so
 * we search the FOUNDATION, not the parent corporation. The CRM stores these
 * names a few ways; we normalize to the philanthropic entity:
 *
 *   "Wells Fargo / Wells Fargo Foundation" → "Wells Fargo Foundation"
 *   "Old National Bank / Foundation"        → "Old National Bank Foundation"
 *   "Google / Google.org"                   → "Google.org"
 *   "Bank of America"                       → "Bank of America Foundation"
 *   "3M Foundation"                         → "3M Foundation"
 *   "Monsanto Fund"                         → "Monsanto Fund"
 *
 * Only applied to corporate_foundation / bank_foundation subtypes (see
 * buildIngestTargets); every other funder keeps its name verbatim.
 */
export function foundationSearchName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes("/")) {
    const parts = trimmed
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    const corp = parts[0] ?? trimmed;
    // Prefer the last segment that already names a foundation/philanthropy.
    const foundationPart = [...parts]
      .reverse()
      .find((p) => FOUNDATION_MARKER.test(p));
    if (foundationPart) {
      // A bare "Foundation" segment is meaningless on its own — qualify it
      // with the corporation name (e.g. "Old National Bank Foundation").
      if (/^foundation$/i.test(foundationPart)) return `${corp} Foundation`;
      return foundationPart;
    }
    // No foundation marker anywhere — qualify the corporation.
    return `${corp} Foundation`;
  }
  if (FOUNDATION_MARKER.test(trimmed)) return trimmed;
  return `${trimmed} Foundation`;
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

/** Build the full target list: all grant-issuing organizations + monitored-capacity people. */
export async function buildIngestTargets(): Promise<IngestTarget[]> {
  const corporateSubtypes = new Set<string>(CORPORATE_FOUNDATION_SUBTYPES);
  const [orgRows, personRows] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        entityType: organizations.entityType,
      })
      .from(organizations)
      .where(eq(organizations.issuesGrants, true)),
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
  for (const f of orgRows) {
    const raw = f.name?.trim();
    if (!raw) continue;
    // Corporate/bank foundations: search the foundation, not the parent
    // corporation, to avoid drowning in unrelated company/market news.
    const name =
      f.entityType && corporateSubtypes.has(f.entityType)
        ? foundationSearchName(raw)
        : raw;
    targets.push({ kind: "organization", id: f.id, name });
  }
  for (const p of personRows) {
    const name = personDisplayName(p);
    if (name) targets.push({ kind: "person", id: p.id, name });
  }
  return targets;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TRACKING_QUERY_PARAM = /^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i;

/** Stable URL identity with fragments and common campaign trackers removed. */
export function canonicalizeMediaUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_PARAM.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw.trim();
  }
}

/** ASCII normalization mirrored by migration 0239 for historical rows. */
export function normalizeMediaHeadline(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function mediaHeadlineFingerprint(title: string): string | null {
  const normalized = normalizeMediaHeadline(title);
  if (normalized.length < 12) return null;
  return createHash("md5").update(normalized).digest("hex");
}

/**
 * Person-name searches are intrinsically ambiguous. GDELT can match a name
 * only in body text, which caused the Scott Cook/police false links. Require
 * the full searched name in the headline before a person result is eligible.
 */
export function isArticleRelevantToTarget(
  target: IngestTarget,
  article: { title: string },
): boolean {
  if (target.kind === "organization") return true;
  const title = normalizeMediaHeadline(article.title);
  const name = normalizeMediaHeadline(target.name);
  return name.length >= 5 && title.includes(name);
}

/**
 * Atomically upsert a single article for one entity. Returns
 * "created" | "linked" | "noop".
 *
 * Transaction-scoped advisory locks serialize both the canonical URL and the
 * same-day headline fingerprint. This collapses tracking variants and exact
 * syndicated reposts while preserving one row with all relevant entity links.
 */
const ENTITY_COLUMN = {
  organization: "organization_ids",
  person: "person_ids",
} as const;

export async function upsertArticle(
  target: IngestTarget,
  article: { url: string; title: string; domain: string; publicationDate: string | null },
): Promise<"created" | "linked" | "noop"> {
  // Column name comes from a fixed whitelist above — safe for sql.raw.
  const col = sql.raw(ENTITY_COLUMN[target.kind]);
  const canonicalUrl = canonicalizeMediaUrl(article.url);
  const headlineFingerprint = mediaHeadlineFingerprint(article.title);
  const lockKeys = [
    `url:${canonicalUrl}`,
    ...(headlineFingerprint
      ? [`headline:${headlineFingerprint}:${article.publicationDate ?? ""}`]
      : []),
  ].sort();

  return db.transaction(async (tx) => {
    for (const key of lockKeys) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    }

    const existing = await tx.execute<{ id: string; dismissed: boolean }>(sql`
      SELECT id, dismissed
      FROM media_mentions
      WHERE url = ${article.url}
         OR canonical_url = ${canonicalUrl}
         OR (
           ${headlineFingerprint}::text IS NOT NULL
           AND headline_fingerprint = ${headlineFingerprint}
           AND publication_date IS NOT DISTINCT FROM ${article.publicationDate}::date
         )
      ORDER BY dismissed ASC, created_at ASC
      LIMIT 1
    `);
    const found = existing.rows[0];
    if (found) {
      if (found.dismissed) return "noop";
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE media_mentions
        SET ${col} = array_append(coalesce(${col}, '{}'::text[]), ${target.id}),
            canonical_url = coalesce(canonical_url, ${canonicalUrl}),
            headline_fingerprint = coalesce(headline_fingerprint, ${headlineFingerprint}),
            updated_at = now()
        WHERE id = ${found.id}
          AND NOT (coalesce(${col}, '{}'::text[]) @> ARRAY[${target.id}]::text[])
        RETURNING id
      `);
      return updated.rows[0] ? "linked" : "noop";
    }

    await tx.execute(sql`
      INSERT INTO media_mentions
        (id, publication_name, title, url, canonical_url, headline_fingerprint,
         publication_date, source, ${col}, created_at, updated_at)
      VALUES (
        ${newId()},
        ${article.domain || "Unknown source"},
        ${article.title || null},
        ${article.url},
        ${canonicalUrl},
        ${headlineFingerprint},
        ${article.publicationDate},
        'gdelt',
        ARRAY[${target.id}]::text[],
        now(), now()
      )
    `);
    return "created";
  });
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
        targetKind: target.kind,
      });
      summary.articlesSeen += articles.length;
      let touched = false;
      for (const article of articles) {
        if (!isArticleRelevantToTarget(target, article)) continue;
        const outcome = await upsertArticle(target, article);
        if (outcome === "created") {
          summary.mentionsCreated += 1;
          touched = true;
        } else if (outcome === "linked") {
          summary.mentionsLinked += 1;
          touched = true;
        }
      }
      if (touched) {
        // A new/linked media mention is a fresh relationship signal — refresh
        // this entity's cached next-step suggestion (debounced + gated).
        enqueueTaskSuggestion(
          target.kind === "person"
            ? { kind: "person", id: target.id }
            : { kind: "organization", id: target.id },
        );
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
