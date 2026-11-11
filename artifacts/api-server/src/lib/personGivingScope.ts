import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

type DonorColumns = {
  individualGiverPersonId: SQLWrapper;
  householdId: SQLWrapper;
  organizationId: SQLWrapper;
};

/** Organizations whose giving is credited through the person's current principal roles. */
export function personPrincipalOrganizations(personId: SQLWrapper): SQL {
  return sql`SELECT DISTINCT giving_role.organization_id FROM people_entity_roles giving_role
    WHERE giving_role.person_id = ${personId}
      AND giving_role.connection = 'principal' AND giving_role.current = 'current'
      AND giving_role.organization_id IS NOT NULL`;
}

/** One attribution authority for individual giving views, pipeline, and AI context. */
export function personGivingAttribution(
  personId: string | SQLWrapper,
  donor: DonorColumns,
): SQL<string | null> {
  return sql`(SELECT CASE
    WHEN ${donor.individualGiverPersonId} = giving_person.id THEN 'direct'
    WHEN ${donor.householdId} = giving_person.primary_household_id THEN 'household'
    WHEN ${donor.organizationId} IN (${personPrincipalOrganizations(sql`giving_person.id`)})
      THEN 'principal_organization'
    ELSE NULL END
    FROM people giving_person WHERE giving_person.id = ${personId} AND giving_person.archived_at IS NULL)`;
}

export function personGivingScope(
  personId: string | SQLWrapper,
  donor: DonorColumns,
): SQL {
  return sql`${personGivingAttribution(personId, donor)} IS NOT NULL`;
}
