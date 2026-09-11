import { createHash } from "node:crypto";

export const DEFAULT_MEDIA_RELEVANCE_THRESHOLD = 0.4;

const DEFAULT_DISQUALIFYING_TERMS = [
  "arrest",
  "charged",
  "crime",
  "football",
  "high school sports",
  "obituary",
  "police",
  "sentenced",
];

const POSITIVE_CONTEXT_TERMS = [
  "charity",
  "donation",
  "foundation",
  "grant",
  "nonprofit",
  "philanthropic",
  "philanthropy",
];

const TRACKING_QUERY_PARAM =
  /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|vero_conv|vero_id)$/i;

const SYNDICATION_HOSTS = new Set([
  "aol.com",
  "apple.news",
  "flipboard.com",
  "msn.com",
  "news.yahoo.com",
  "yahoo.com",
]);

export interface MediaRelevanceTarget {
  kind: "organization" | "person";
  id: string;
  name: string;
  affiliations?: string[];
  locations?: string[];
}

export interface MediaArticleSignals {
  url: string;
  title: string;
  domain?: string;
  publicationDate?: string | null;
  snippet?: string | null;
  body?: string | null;
  originalUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MediaRelevanceConfig {
  disqualifyingTerms?: string[];
}

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

function hostFor(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isSyndicationUrl(raw: string): boolean {
  const host = hostFor(raw);
  if (!host) return false;
  return [...SYNDICATION_HOSTS].some(
    (known) => host === known || host.endsWith(`.${known}`),
  );
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/&amp;/g, "&");
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

function metadataUrlCandidates(
  metadata: Record<string, unknown> | null | undefined,
) {
  if (!metadata) return [];
  const keys = [
    "canonicalUrl",
    "canonical_url",
    "originalUrl",
    "original_url",
    "sourceUrl",
    "source_url",
    "og:url",
    "url",
  ];
  return keys
    .map((key) => httpUrl(metadata[key]))
    .filter((v): v is string => !!v);
}

function bodyUrlCandidates(body: string | null | undefined): string[] {
  if (!body) return [];
  const out: string[] = [];
  const patterns = [
    /<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["']/gi,
    /<meta\b[^>]*(?:property|name)=["']og:url["'][^>]*\bcontent=["']([^"']+)["']/gi,
    /["'](?:canonicalUrl|originalUrl|sourceUrl)["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const value = httpUrl(match[1]);
      if (value) out.push(value);
    }
  }
  return out;
}

/**
 * Prefer an original publisher URL exposed in metadata/body when an article
 * is a Yahoo/MSN/AOL-style syndication wrapper. This is deliberately
 * best-effort and never performs another network request.
 */
export function canonicalizeMediaArticleUrl(
  article: MediaArticleSignals,
): string {
  const raw = canonicalizeMediaUrl(article.url);
  if (!isSyndicationUrl(raw)) return raw;
  const candidates = [
    httpUrl(article.originalUrl),
    ...metadataUrlCandidates(article.metadata),
    ...bodyUrlCandidates(article.body),
    ...bodyUrlCandidates(article.snippet),
  ].filter((value): value is string => !!value);
  const original = candidates
    .map(canonicalizeMediaUrl)
    .find((value) => !isSyndicationUrl(value));
  return original ?? raw;
}

export function normalizeMediaText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** ASCII normalization mirrored by migration 0239 for historical rows. */
export function normalizeMediaHeadline(title: string): string {
  return normalizeMediaText(title).replace(/\s+/g, "");
}

export function mediaHeadlineFingerprint(title: string): string | null {
  const normalized = normalizeMediaHeadline(title);
  if (normalized.length < 12) return null;
  return createHash("md5").update(normalized).digest("hex");
}

export function mediaRelevanceThreshold(
  raw = process.env.MEDIA_RELEVANCE_THRESHOLD,
): number {
  if (raw == null || raw.trim() === "")
    return DEFAULT_MEDIA_RELEVANCE_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_MEDIA_RELEVANCE_THRESHOLD;
}

export function mediaDisqualifyingTerms(
  raw = process.env.MEDIA_RELEVANCE_DISQUALIFYING_TERMS,
): string[] {
  if (raw == null || raw.trim() === "") return [...DEFAULT_DISQUALIFYING_TERMS];
  return raw.split(",").map(normalizeMediaText).filter(Boolean);
}

function includesSignal(text: string, value: string): boolean {
  const normalized = normalizeMediaText(value);
  return normalized.length >= 3 && ` ${text} `.includes(` ${normalized} `);
}

/** Deterministic 0..1 relevance score for one target/article pair. */
export function scoreMediaRelevance(
  target: MediaRelevanceTarget,
  article: MediaArticleSignals,
  config: MediaRelevanceConfig = {},
): number {
  // Organization searches already use an exact quoted name and historically
  // admitted all results. The extra context signals apply to namesake-prone
  // individual searches.
  if (target.kind === "organization") return 1;

  const title = normalizeMediaText(article.title);
  const detail = normalizeMediaText(
    [article.snippet, article.body].filter(Boolean).join(" "),
  );
  const combined = `${title} ${detail}`.trim();
  const nameInTitle = includesSignal(title, target.name);
  const nameInDetail = includesSignal(detail, target.name);
  const affiliationInTitle = (target.affiliations ?? []).some((value) =>
    includesSignal(title, value),
  );
  const affiliationInDetail = (target.affiliations ?? []).some((value) =>
    includesSignal(detail, value),
  );
  const locationMatch = (target.locations ?? []).some((value) =>
    includesSignal(combined, value),
  );
  const positiveContext = POSITIVE_CONTEXT_TERMS.some((value) =>
    includesSignal(combined, value),
  );
  const disqualifying = (
    config.disqualifyingTerms ?? mediaDisqualifyingTerms()
  ).some((value) => includesSignal(combined, value));

  let score = 0.05;
  if (nameInTitle) score += 0.3;
  else if (nameInDetail) score += 0.2;
  if (affiliationInTitle) score += 0.35;
  else if (affiliationInDetail) score += 0.25;
  if (locationMatch) score += 0.2;
  if ((nameInTitle || nameInDetail) && positiveContext) score += 0.15;
  if (disqualifying) {
    const corroborated =
      affiliationInTitle || affiliationInDetail || locationMatch;
    score -= corroborated ? 0.15 : 0.45;
  }

  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

export function isMediaMentionFiltered(
  score: number,
  pinned = false,
  threshold = mediaRelevanceThreshold(),
): boolean {
  return !pinned && score < threshold;
}
