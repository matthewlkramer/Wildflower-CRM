import {
  fetchPublicResearchMarkup,
  parseSearchResults,
  stripHtml,
} from "./conferencePublicWebResearch";
import { searchGdelt, type GdeltArticle } from "./gdelt";
import { normalizeMediaText } from "./mediaRelevance";
import { shiftDate, type FunderTarget } from "./funderCadence";
import type { findingCategories } from "@workspace/db/schema";

const NEWS_PATH =
  /\/(news(?:room)?|press(?:-releases)?|announcements?|updates?|grants?|funding|opportunities|rfps?|blog)(?:[/-]|$)/i;
const LISTING_PATH =
  /\/(news(?:room)?|press(?:-releases)?|announcements?|updates?|grants?|funding|opportunities|rfps?|blog)\/?$/i;
const FUNDING =
  /\b(request for proposals|call for (?:proposals|applications)|(?:grant |funding )?applications? (?:are |is )?(?:now )?open|accepting (?:grant )?applications|open grant cycle|apply for (?:a |the )?(?:grant|funding|fellowship))\b/i;
const AWARDED =
  /\b(awards? grants? to|announces? (?:the )?(?:recipients|awardees|grantees)|grants? awarded|applications? (?:are |is )?closed)\b/i;
const LEADERSHIP =
  /\b(appoints?|names?|welcomes?|steps down|retires?)\b.{0,90}\b(executive director|chief|president|ceo|program officer|board|director)\b|\b(new|interim) (?:ceo|president|executive director|program officer)\b/i;
const STRATEGY =
  /\b(strategic plan|funding priorities|new (?:strategy|priorities|focus areas)|annual report|grantmaking strategy|strategic priorities)\b/i;

export interface PublicFunderFinding {
  article: GdeltArticle;
  category: (typeof findingCategories)[number];
  summary: string | null;
  deadline: string | null;
  official: boolean;
}

function sameWebsite(url: URL, website: URL | null): boolean {
  if (!website) return false;
  const host = website.hostname.replace(/^www\./, "");
  return url.hostname === host || url.hostname.endsWith("." + host);
}

function websiteUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : "https://" + value,
    );
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function isoDate(text: string | undefined): string | null {
  const date = text?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) return null;
  const parsed = new Date(date + "T00:00:00Z");
  return Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}

function publishedOn(markup: string): string | null {
  const structured = /"datePublished"\s*:\s*"([^"]+)"/i.exec(markup)?.[1];
  const meta = markup.match(
    /<meta\b[^>]*(?:article:published_time|datePublished)[^>]*>/i,
  )?.[0];
  return (
    isoDate(structured) ?? isoDate(meta?.match(/content=["']([^"']+)/i)?.[1])
  );
}

export function classifyFunderFinding(args: {
  title: string;
  evidence: string;
  published: string;
  today: string;
  official: boolean;
}): Pick<PublicFunderFinding, "category" | "deadline"> {
  const { title, evidence, published, today, official } = args;
  const deadlineText = evidence.match(
    /\b(?:deadline\s*(?:is|:)?|apply by|due by|applications close(?: on)?)\s*((?:\d{4}-\d{2}-\d{2})|(?:[A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}))/i,
  )?.[1];
  const parsedDeadline =
    deadlineText && !/^\d{4}-/.test(deadlineText)
      ? new Date(deadlineText + " UTC")
      : null;
  const deadline =
    isoDate(deadlineText) ??
    (parsedDeadline && Number.isFinite(parsedDeadline.valueOf())
      ? parsedDeadline.toISOString().slice(0, 10)
      : null);
  if (
    !AWARDED.test(title) &&
    !AWARDED.test(evidence) &&
    (FUNDING.test(title) || (official && FUNDING.test(evidence)))
  ) {
    if (deadline && deadline >= today && deadline <= shiftDate(today, 365))
      return { category: "funding_opportunity", deadline };
    if (
      !deadline &&
      official &&
      FUNDING.test(title) &&
      published >= shiftDate(today, -7)
    ) {
      return { category: "funding_opportunity", deadline: null };
    }
  }
  if (LEADERSHIP.test(title))
    return { category: "leadership_staff", deadline: null };
  if (STRATEGY.test(title))
    return { category: "strategy_priorities", deadline: null };
  return { category: "general_news", deadline: null };
}

export async function researchPublicFunder(
  target: Pick<FunderTarget, "searchName" | "website"> &
    Partial<Pick<FunderTarget, "entityType">>,
  since: string,
  today: string,
  sources = { fetchPage: fetchPublicResearchMarkup, searchNews: searchGdelt },
): Promise<{ findings: PublicFunderFinding[]; complete: boolean }> {
  const website = websiteUrl(target.website);
  const lookback = Math.min(
    60,
    Math.round((Date.parse(today) - Date.parse(since)) / 86_400_000) + 1,
  );
  const name = target.searchName.replace(/["]/g, "");
  const query = [
    `"${name}" (grant OR newsroom OR "strategic plan" OR leadership)`,
    ...(website
      ? [
          `site:${website.hostname.replace(/^www\./, "")} (grants OR news OR announcements OR strategy OR leadership)`,
        ]
      : []),
  ];
  const results = await Promise.allSettled([
    sources.searchNews(name, {
      timespanDays: lookback,
      maxRecords: 10,
      retries: 0,
      timeoutMs: 8_000,
      strict: true,
    }),
    ...query.map(async (terms) => {
      const page = await sources.fetchPage(
        "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(terms),
      );
      if (!/<rss\b/i.test(page.markup))
        throw new Error("Public search returned an unreadable feed");
      return parseSearchResults(page.markup).slice(0, 6);
    }),
    ...(website ? [sources.fetchPage(website.toString())] : []),
  ]);
  if (results.every((result) => result.status === "rejected"))
    throw new Error("Public sources were unavailable");

  type Candidate = {
    url: string;
    title: string | null;
  };
  const candidates = new Map<string, Candidate>();
  const news = results[0];
  if (news?.status === "fulfilled" && Array.isArray(news.value)) {
    for (const item of news.value as GdeltArticle[])
      candidates.set(item.url, {
        url: item.url,
        title: item.title,
      });
  }
  for (const result of results.slice(1)) {
    if (result.status !== "fulfilled") continue;
    if (Array.isArray(result.value)) {
      for (const hit of result.value)
        if (!candidates.has(hit.url)) candidates.set(hit.url, hit);
    } else {
      const { url, markup } = result.value;
      if (!sameWebsite(url, website)) continue;
      candidates.set(url.toString(), { url: url.toString(), title: null });
      for (const link of stripHtml(markup, url.toString()).links) {
        const linkUrl = websiteUrl(link);
        if (
          linkUrl &&
          sameWebsite(linkUrl, website) &&
          NEWS_PATH.test(linkUrl.pathname) &&
          !candidates.has(link)
        ) {
          candidates.set(link, { url: link, title: null });
        }
      }
    }
  }
  const listings = [...candidates.keys()]
    .filter((link) => {
      const url = websiteUrl(link);
      return (
        url && sameWebsite(url, website) && LISTING_PATH.test(url.pathname)
      );
    })
    .slice(0, 4);
  const listingResults = await Promise.allSettled(
    listings.map((link) => sources.fetchPage(link)),
  );
  for (const result of listingResults) {
    if (
      result.status !== "fulfilled" ||
      !sameWebsite(result.value.url, website)
    )
      continue;
    const { url, markup } = result.value;
    for (const link of stripHtml(markup, url.toString()).links) {
      const child = websiteUrl(link);
      if (
        child &&
        sameWebsite(child, website) &&
        NEWS_PATH.test(child.pathname) &&
        !LISTING_PATH.test(child.pathname) &&
        !candidates.has(link)
      ) {
        candidates.set(link, { url: link, title: null });
      }
    }
  }
  const ordered = [...candidates.values()]
    .filter((entry) => websiteUrl(entry.url))
    .sort((a, b) => {
      function priority(value: string) {
        const url = new URL(value);
        return (
          (sameWebsite(url, website) ? 2 : 0) +
          (NEWS_PATH.test(url.pathname) && !LISTING_PATH.test(url.pathname)
            ? 1
            : 0)
        );
      }
      return priority(b.url) - priority(a.url);
    });
  const searchName = normalizeMediaText(name);
  let unavailablePages = 0;
  const findings: PublicFunderFinding[] = [];
  // Bound both the number of public requests and concurrent connections.
  const queue = ordered.slice(0, 16);
  for (let index = 0; index < queue.length; index += 4) {
    const pages = await Promise.all(
      queue.slice(index, index + 4).map(async (candidate) => {
        try {
          const { url, markup } = await sources.fetchPage(candidate.url);
          const official = sameWebsite(url, website);
          const extracted = stripHtml(markup, url.toString());
          const title = extracted.title ?? candidate.title;
          const published = publishedOn(markup);
          if (!title || !published || published < since || published > today)
            return null;
          const evidence = extracted.text.slice(0, 30_000);
          const requiresName =
            !official ||
            target.entityType === "corporate_foundation" ||
            target.entityType === "bank_foundation";
          if (
            requiresName &&
            !(" " + normalizeMediaText(title + " " + evidence) + " ").includes(
              " " + searchName + " ",
            )
          )
            return null;
          const { category, deadline } = classifyFunderFinding({
            title,
            evidence,
            published,
            today,
            official,
          });
          if (
            category !== "funding_opportunity" &&
            (url.pathname === "/" || LISTING_PATH.test(url.pathname))
          )
            return null;
          const topicalEvidence =
            category === "funding_opportunity"
              ? FUNDING
              : category === "strategy_priorities"
                ? STRATEGY
                : category === "leadership_staff"
                  ? LEADERSHIP
                  : null;
          const summary =
            evidence
              .split(/(?<=[.!?])\s+/)
              .find(
                (line) =>
                  line.length >= 50 &&
                  line.length <= 420 &&
                  (topicalEvidence?.test(line) ||
                    normalizeMediaText(line).includes(searchName)),
              ) ?? null;
          return {
            article: {
              url: url.toString(),
              title: title.slice(0, 300),
              domain: url.hostname,
              publicationDate: published,
              language: null,
            },
            category,
            deadline,
            summary,
            official,
          };
        } catch {
          unavailablePages += 1;
          return null;
        }
      }),
    );
    for (const page of pages) if (page) findings.push(page);
  }
  return {
    findings,
    complete:
      unavailablePages === 0 &&
      [...results, ...listingResults].every(
        (result) => result.status === "fulfilled",
      ),
  };
}
