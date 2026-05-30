import { logger } from "./logger";

/**
 * Minimal client for the GDELT DOC 2.0 API (https://api.gdeltproject.org).
 * GDELT is free and requires no API key — it indexes worldwide online news
 * in near-real-time. We use the `ArtList` mode which returns a JSON list of
 * matching articles (headline, source domain, url, seen-date).
 *
 * GDELT has no published per-key rate limit but throttles aggressive callers
 * and occasionally responds with a non-JSON error body (HTML/plain text) when
 * overloaded or when a query is malformed. Every parse path here is defensive:
 * on any failure we log and return an empty list so one bad entity never
 * aborts a whole ingestion run.
 */

const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

export interface GdeltArticle {
  url: string;
  title: string;
  /** Source domain, e.g. "nytimes.com". Used as the publication name. */
  domain: string;
  /** Article seen-date as an ISO `YYYY-MM-DD`, or null if unparseable. */
  publicationDate: string | null;
  language: string | null;
}

interface RawGdeltArticle {
  url?: unknown;
  title?: unknown;
  domain?: unknown;
  seendate?: unknown;
  language?: unknown;
}

/**
 * Build the GDELT `query` parameter for an entity name. We phrase-match the
 * exact name (quoted) to keep precision high, and restrict to English-language
 * sources to cut noise. Quotes inside the name are stripped so we never emit a
 * malformed query.
 */
export function buildGdeltQuery(name: string): string {
  const cleaned = name.replace(/["]/g, "").trim();
  return `"${cleaned}" sourcelang:english`;
}

/**
 * Convert a GDELT `seendate` (`YYYYMMDDTHHMMSSZ`, e.g. `20260530T120000Z`) to
 * an ISO calendar date `YYYY-MM-DD`. Returns null for anything unrecognized.
 */
export function gdeltDateToISO(seendate: unknown): string | null {
  if (typeof seendate !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(seendate.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/**
 * Parse a GDELT ArtList JSON payload into a clean article list. Tolerates the
 * raw body being a JSON string, an already-parsed object, or garbage. Drops
 * any article missing a usable http(s) url. Pure — unit-tested directly.
 */
export function parseGdeltArticles(raw: unknown): GdeltArticle[] {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed[0] !== "{") return [];
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!payload || typeof payload !== "object") return [];
  const articles = (payload as { articles?: unknown }).articles;
  if (!Array.isArray(articles)) return [];

  const out: GdeltArticle[] = [];
  for (const a of articles as RawGdeltArticle[]) {
    if (!a || typeof a !== "object") continue;
    const url = typeof a.url === "string" ? a.url.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const domain = typeof a.domain === "string" ? a.domain.trim() : "";
    out.push({
      url,
      title,
      domain,
      publicationDate: gdeltDateToISO(a.seendate),
      language: typeof a.language === "string" ? a.language.trim() : null,
    });
  }
  return out;
}

export interface SearchGdeltOptions {
  /** Lookback window in days. GDELT caps `timespan` ~ a few months. */
  timespanDays?: number;
  /** Max articles to request (GDELT ArtList max is 250). */
  maxRecords?: number;
  /** Abort each HTTP attempt after this many ms. */
  timeoutMs?: number;
  /** Extra attempts on transient network failure (connect timeout, etc.). */
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Search GDELT for recent articles mentioning `name`. Never throws — returns
 * [] on network error, timeout, non-200, or unparseable body. Retries a few
 * times with linear backoff on transient connect failures, since GDELT's free
 * endpoint occasionally times out / rate-limits under load.
 */
export async function searchGdelt(
  name: string,
  opts: SearchGdeltOptions = {},
): Promise<GdeltArticle[]> {
  const { timespanDays = 2, maxRecords = 25, timeoutMs = 20_000, retries = 2 } = opts;
  const params = new URLSearchParams({
    query: buildGdeltQuery(name),
    mode: "ArtList",
    format: "json",
    sort: "DateDesc",
    maxrecords: String(Math.min(Math.max(maxRecords, 1), 250)),
    timespan: `${Math.max(timespanDays, 1)}d`,
  });
  const url = `${GDELT_DOC_URL}?${params.toString()}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "wildflower-crm-media-ingest/1.0" },
      });
      if (res.status === 429 || res.status >= 500) {
        // Transient server-side throttle/error — worth retrying.
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        logger.warn({ status: res.status, name }, "GDELT search throttled/5xx");
        return [];
      }
      if (!res.ok) {
        logger.warn({ status: res.status, name }, "GDELT search non-200");
        return [];
      }
      return parseGdeltArticles(await res.text());
    } catch (err) {
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      logger.warn(
        { errClass: err instanceof Error ? err.name : typeof err, name },
        "GDELT search failed after retries",
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}
