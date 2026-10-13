import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

type DonorColumns = {
  individualGiverPersonId: SQLWrapper;
  householdId: SQLWrapper;
  organizationId: SQLWrapper;
};

/** One attribution authority for individual giving views, pipeline, and AI context. */
export function personGivingAttribution(
  personId: string | SQLWrapper,
  donor: DonorColumns,
): SQL<string | null> {
  return sql`(SELECT CASE
    WHEN ${donor.individualGiverPersonId} = giving_person.id THEN 'direct'
    WHEN ${donor.householdId} = giving_person.primary_household_id THEN 'household'
    WHEN EXISTS (
      SELECT 1 FROM people_entity_roles giving_role
      WHERE giving_role.person_id = giving_person.id
        AND giving_role.organization_id = ${donor.organizationId}
        AND giving_role.connection = 'principal' AND giving_role.current = 'current'
    ) THEN 'principal_organization'
    ELSE NULL END
    FROM people giving_person WHERE giving_person.id = ${personId} AND giving_person.archived_at IS NULL)`;
}

export function personGivingScope(
  personId: string | SQLWrapper,
  donor: DonorColumns,
): SQL {
  return sql`${personGivingAttribution(personId, donor)} IS NOT NULL`;
}
