import { extractNamedGrantProgram } from "./grantLeadIdentity";

const MAX_HEADLINE_WORDS = 35;

export type GrantLeadHeadlineSource = {
  title: string;
  funderName: string | null;
  snippet: string | null;
};

export type GrantLeadHeadlineIdentity = {
  funderName: string | null;
  programName: string | null;
};

export function getGrantLeadHeadlineIdentity(
  lead: GrantLeadHeadlineSource,
): GrantLeadHeadlineIdentity {
  return {
    funderName: lead.funderName?.trim() || null,
    programName: extractNamedGrantProgram(
      `${lead.title}\n${lead.snippet ?? ""}`,
    ),
  };
}

function normalizeForComparison(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function includesIdentity(headline: string, identity: string): boolean {
  const normalizedHeadline = normalizeForComparison(headline);
  const normalizedIdentity = normalizeForComparison(identity);
  return Boolean(
    normalizedIdentity && normalizedHeadline.includes(normalizedIdentity),
  );
}

export function clampGrantLeadHeadline(value: string): string {
  const oneLine = value
    .replace(/^[\s'"]+|[\s'"]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return "";
  const firstSentence = oneLine.match(/^[^.!?]{1,400}[.!?]?/)?.[0] ?? oneLine;
  const words = firstSentence
    .trim()
    .split(/\s+/)
    .slice(0, MAX_HEADLINE_WORDS)
    .join(" ");
  const clamped = words.slice(0, 400).trim();
  if (!clamped) return "";
  return /[.!?]$/.test(clamped) ? clamped : `${clamped}.`;
}

/**
 * Enforce the product contract after generation. The prompt asks for both
 * names when available; this guard guarantees that a known funder and/or
 * named program cannot disappear from the displayed headline.
 */
export function finalizeGrantLeadHeadline(
  raw: string,
  identity: GrantLeadHeadlineIdentity,
): string {
  const base = clampGrantLeadHeadline(raw);
  if (!base) return "";

  const knownNames = [identity.funderName, identity.programName].filter(
    (name): name is string => Boolean(name),
  );
  const missingNames = knownNames.filter(
    (name) => !includesIdentity(base, name),
  );
  if (missingNames.length === 0) return base;

  const withoutFinalPunctuation = base.replace(/[.!?]+$/, "");
  return clampGrantLeadHeadline(
    `${missingNames.join(" — ")}: ${withoutFinalPunctuation}.`,
  );
}
