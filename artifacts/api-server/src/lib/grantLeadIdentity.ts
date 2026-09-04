import type { GrantOpportunity } from "./intelDetectors";

const TRACKING_HOST_RE =
  /(?:^|\.)(?:hubspotlinks\.com|list-manage\.com|mailchi\.mp|beehiiv\.com|constantcontact\.com|safelinks\.protection\.outlook\.com|luma\.com)$/i;
const TRACKING_PATH_RE = /\/(?:click|track|redirect|r)\//i;
const ASSET_PATH_RE = /\.(?:png|jpe?g|gif|webp|svg|pdf)(?:$|\?)/i;

export function canonicalOpportunityUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (
      TRACKING_HOST_RE.test(u.hostname) ||
      TRACKING_PATH_RE.test(u.pathname) ||
      ASSET_PATH_RE.test(u.pathname)
    ) {
      return null;
    }
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(?:utm_|mc_|fbclid$|gclid$|ref$|source$)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    const query = u.searchParams.toString();
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "").toLowerCase()}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

// Prefer the actual named program over newsletter subject variations such as
// "Q&A reminder" vs "2027 cycle open". This is intentionally conservative:
// it only recognizes a capitalized proper-name phrase ending in a common
// funding-program noun.
function namedProgram(text: string): string | null {
  const candidates = text.match(
    /\b(?:[A-Z][\w&'’.-]*|\$?\d[\d,.]*)(?:\s+(?:[A-Z][\w&'’.-]*|and|of|for|the|\$?\d[\d,.]*)){1,9}\s+(?:Grant\s+Program|Grant\s+Fund|Fellowship|Initiative|Challenge|Prize|Fund)\b/g,
  );
  if (!candidates?.length) return null;
  return (
    candidates
      .map((v) => v.trim())
      .filter((v) => !/^Selected\b/i.test(v))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

function normalizeIdentity(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(?:re|fwd):\s*/g, "")
    .replace(
      /^(?:(?:applications?|lois?|deadline|funding)\s+(?:for\s+)?(?:the\s+)?|the\s+)/,
      "",
    )
    .replace(
      /\b(?:newsletter|e-?news|digest|reminder|registration|webinar|q\s*&\s*a|now\s+open|applications?\s+(?:are\s+)?(?:now\s+)?open)\b/g,
      " ",
    )
    .replace(/[^a-z0-9$]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

/**
 * One opportunity identity across re-announcements. A specific named funding
 * program wins even when different newsletters point to different articles or
 * tracking links. Stable destination URLs are the fallback, followed by the
 * sender/funder plus normalized announcement title. Deadline is deliberately
 * not part of the key: reminder emails often add or clarify it, and should
 * become sightings of the same lead rather than new leads.
 */
export function buildGrantLeadDedupeKey(
  opportunity: GrantOpportunity,
  fromEmail: string | null,
): string {
  const program = namedProgram(`${opportunity.title}\n${opportunity.snippet}`);
  if (program)
    return `grant:program:${normalizeIdentity(program)}`.slice(0, 260);

  const canonicalUrl = canonicalOpportunityUrl(opportunity.url);
  if (canonicalUrl) return `grant:url:${canonicalUrl.slice(0, 180)}`;

  const titleKey = normalizeIdentity(opportunity.title);
  const funderKey = normalizeIdentity(opportunity.funderName ?? "");
  const senderDomain = fromEmail?.split("@").pop()?.toLowerCase() ?? "";
  const discriminator = funderKey || senderDomain || "unknown-source";
  return `grant:announcement:${discriminator}:${titleKey || "unnamed"}`.slice(
    0,
    260,
  );
}
