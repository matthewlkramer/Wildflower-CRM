import { db } from "@workspace/db";
import {
  addresses,
  organizations,
  people,
  peopleEntityRoles,
  regions,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { MediaRelevanceTarget } from "./mediaRelevance";

/** Best searchable display name; one-token fallbacks are too ambiguous. */
export function personDisplayName(person: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string | null {
  const full = person.fullName?.trim();
  if (full) return full;
  const parts = [person.firstName?.trim(), person.lastName?.trim()].filter(
    (value): value is string => !!value,
  );
  return parts.length >= 2 ? parts.join(" ") : null;
}

function uniqueSignals(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter(Boolean) as string[],
    ),
  ];
}

/** Shared person context for live ingestion and the manual backfill. */
export async function loadPersonRelevanceTargets(
  personIds: string[],
): Promise<MediaRelevanceTarget[]> {
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return [];

  const personRows = await db
    .select({
      id: people.id,
      fullName: people.fullName,
      firstName: people.firstName,
      lastName: people.lastName,
      currentHomeRegionId: people.currentHomeRegionId,
    })
    .from(people)
    .where(inArray(people.id, ids));
  const homeRegionIds = uniqueSignals(
    personRows.map((row) => row.currentHomeRegionId),
  );

  const [roleRows, addressRows, regionRows] = await Promise.all([
    db
      .select({
        personId: peopleEntityRoles.personId,
        organizationName: organizations.name,
      })
      .from(peopleEntityRoles)
      .innerJoin(
        organizations,
        eq(organizations.id, peopleEntityRoles.organizationId),
      )
      .where(
        and(
          inArray(peopleEntityRoles.personId, ids),
          eq(peopleEntityRoles.entityType, "organization"),
          eq(peopleEntityRoles.current, "current"),
        ),
      ),
    db
      .select({ personId: addresses.personId, cityName: addresses.cityName })
      .from(addresses)
      .where(inArray(addresses.personId, ids)),
    homeRegionIds.length
      ? db
          .select({
            id: regions.id,
            name: regions.name,
            displayPath: regions.displayPath,
          })
          .from(regions)
          .where(inArray(regions.id, homeRegionIds))
      : Promise.resolve([]),
  ]);

  const regionById = new Map(regionRows.map((row) => [row.id, row]));
  return personRows.flatMap((person) => {
    const name = personDisplayName(person);
    if (!name) return [];
    const homeRegion = person.currentHomeRegionId
      ? regionById.get(person.currentHomeRegionId)
      : undefined;
    return [
      {
        kind: "person" as const,
        id: person.id,
        name,
        affiliations: uniqueSignals(
          roleRows
            .filter((row) => row.personId === person.id)
            .map((row) => row.organizationName),
        ),
        locations: uniqueSignals([
          ...addressRows
            .filter((row) => row.personId === person.id)
            .map((row) => row.cityName),
          homeRegion?.name,
          homeRegion?.displayPath,
        ]),
      },
    ];
  });
}
