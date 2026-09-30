import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  emails,
  organizations,
  people,
  peopleEntityRoles,
} from "@workspace/db/schema";

export interface SpeakerCandidate {
  personId: string;
  name: string;
  organizationId: string | null;
  organizationName: string | null;
  matchEvidence: string | null;
  email?: string | null;
}

export interface SpeakerMatch {
  matchedPersonId: string | null;
  matchedOrganizationId: string | null;
  candidates: SpeakerCandidate[];
  evidence: string | null;
}

export function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function matchSpeakerCandidates(args: {
  name: string;
  email?: string | null;
  organizationName?: string | null;
  candidates: SpeakerCandidate[];
}): SpeakerMatch {
  const name = normalizeIdentity(args.name);
  const email = args.email?.trim().toLocaleLowerCase("en") ?? "";
  const org = normalizeIdentity(args.organizationName);
  const emailMatches = email
    ? args.candidates.filter((candidate) =>
        candidate.email?.trim().toLocaleLowerCase("en") === email,
      )
    : [];
  if (emailMatches.length === 1) {
    const candidate = emailMatches[0];
    return {
      matchedPersonId: candidate.personId,
      matchedOrganizationId: candidate.organizationId,
      candidates: emailMatches,
      evidence: "Unique exact email match to an existing CRM person.",
    };
  }
  if (emailMatches.length > 1) {
    return {
      matchedPersonId: null,
      matchedOrganizationId: null,
      candidates: emailMatches,
      evidence: "Public email matched multiple CRM people.",
    };
  }

  const nameMatches = args.candidates.filter(
    (candidate) => normalizeIdentity(candidate.name) === name,
  );
  if (nameMatches.length === 1 && org) {
    const organizationMatches = nameMatches.filter(
      (candidate) => normalizeIdentity(candidate.organizationName) === org,
    );
    if (organizationMatches.length === 1 && organizationMatches[0].organizationId) {
      const candidate = organizationMatches[0];
      return {
        matchedPersonId: candidate.personId,
        matchedOrganizationId: candidate.organizationId,
        candidates: [candidate],
        evidence: "Unique normalized full-name match corroborated by current organization.",
      };
    }
  }
  return {
    matchedPersonId: null,
    matchedOrganizationId: null,
    candidates: nameMatches.length ? nameMatches : args.candidates,
    evidence: nameMatches.length
      ? "Name match was ambiguous or lacked corroborating current organization."
      : null,
  };
}

/**
 * Only current, non-archived CRM identities are considered. Organization
 * corroboration uses an existing current organization role; research never
 * creates or links an organization based on a similar name.
 */
export async function findConferenceSpeakerMatch(args: {
  name: string;
  email?: string | null;
  organizationName?: string | null;
}): Promise<SpeakerMatch> {
  const normalizedName = normalizeIdentity(args.name);
  const email = args.email?.trim().toLocaleLowerCase("en") ?? "";
  const identityPredicate = email
    ? sql`lower(${emails.email}) = ${email} OR lower(trim(concat_ws(' ', ${people.firstName}, ${people.lastName}))) = ${normalizedName} OR lower(trim(coalesce(${people.fullName}, ''))) = ${normalizedName}`
    : sql`lower(trim(concat_ws(' ', ${people.firstName}, ${people.lastName}))) = ${normalizedName} OR lower(trim(coalesce(${people.fullName}, ''))) = ${normalizedName}`;

  const rows = await db
    .select({
      personId: people.id,
      firstName: people.firstName,
      lastName: people.lastName,
      fullName: people.fullName,
      organizationId: organizations.id,
      organizationName: organizations.name,
      email: emails.email,
    })
    .from(people)
    .leftJoin(emails, eq(emails.personId, people.id))
    .leftJoin(
      peopleEntityRoles,
      and(
        eq(peopleEntityRoles.personId, people.id),
        eq(peopleEntityRoles.entityType, "organization"),
        eq(peopleEntityRoles.current, "current"),
      ),
    )
    .leftJoin(organizations, eq(organizations.id, peopleEntityRoles.organizationId))
    .where(and(isNull(people.archivedAt), identityPredicate));

  const candidateByPerson = new Map<string, SpeakerCandidate>();
  for (const row of rows) {
    const name = row.fullName?.trim() ||
      [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
    if (!name) continue;
    const candidate: SpeakerCandidate = {
      personId: row.personId,
      name,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      matchEvidence: null,
      email: row.email,
    };
    const existing = candidateByPerson.get(row.personId);
    const corroboratesOrg = !!args.organizationName &&
      normalizeIdentity(candidate.organizationName) === normalizeIdentity(args.organizationName);
    const existingCorroboratesOrg = !!args.organizationName &&
      normalizeIdentity(existing?.organizationName) === normalizeIdentity(args.organizationName);
    if (!existing || (corroboratesOrg && !existingCorroboratesOrg) ||
      (candidate.organizationId && !existing.organizationId)) {
      candidateByPerson.set(row.personId, candidate);
    }
  }

  const candidateRows = [...candidateByPerson.values()];
  const exactEmailRows = email
    ? await db
        .select({
          personId: people.id,
          firstName: people.firstName,
          lastName: people.lastName,
          fullName: people.fullName,
          organizationId: organizations.id,
          organizationName: organizations.name,
          email: emails.email,
        })
        .from(emails)
        .innerJoin(people, eq(people.id, emails.personId))
        .leftJoin(
          peopleEntityRoles,
          and(
            eq(peopleEntityRoles.personId, people.id),
            eq(peopleEntityRoles.entityType, "organization"),
            eq(peopleEntityRoles.current, "current"),
          ),
        )
        .leftJoin(organizations, eq(organizations.id, peopleEntityRoles.organizationId))
        .where(and(sql`lower(${emails.email}) = ${email}`, sql`${people.archivedAt} IS NULL`))
    : [];
  for (const row of exactEmailRows) {
    const name = row.fullName?.trim() ||
      [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
    if (name && !candidateByPerson.has(row.personId)) {
      candidateByPerson.set(row.personId, {
        personId: row.personId,
        name,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        matchEvidence: null,
        email: row.email,
      });
    }
  }
  return matchSpeakerCandidates({
    name: args.name,
    email: args.email,
    organizationName: args.organizationName,
    candidates: [...candidateByPerson.values()],
  });
}