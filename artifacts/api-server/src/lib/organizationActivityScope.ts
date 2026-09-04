import { or, sql, type SQL } from "drizzle-orm";

/**
 * Relationship activity shown on an organization page includes activity
 * linked directly to the organization OR to a person who currently holds a
 * role there.  Keep this scope in one helper so interactions, email,
 * calendar, meeting notes, intel, and media cannot drift apart.
 */
export function organizationActivityArrayScope(
  organizationId: string,
  organizationIds: SQL,
  personIds: SQL,
): SQL {
  return or(
    sql`${organizationIds} @> ARRAY[${organizationId}]::text[]`,
    sql`${personIds} && ARRAY(
      SELECT per.person_id
      FROM people_entity_roles per
      WHERE per.organization_id = ${organizationId}
        AND per.current = 'current'
    )::text[]`,
  )!;
}

/** Scalar-FK variant used by email-intelligence and media rows. */
export function organizationActivityScalarScope(
  organizationId: string,
  organizationIdColumn: SQL,
  personIdColumn: SQL,
): SQL {
  return or(
    sql`${organizationIdColumn} = ${organizationId}`,
    sql`${personIdColumn} IN (
      SELECT per.person_id
      FROM people_entity_roles per
      WHERE per.organization_id = ${organizationId}
        AND per.current = 'current'
    )`,
  )!;
}
