import { peopleEntityRoles, people } from "@workspace/db/schema";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@workspace/db";

// Shared SELECT shape for people_entity_roles that joins the related
// person row to expose a display name. The COALESCE mirrors the
// pattern used in funders/people primary-contact subqueries:
// prefer full_name, fall back to first+last, NULL if neither has
// non-whitespace content.
export const peopleEntityRolesSelect = {
  ...getTableColumns(peopleEntityRoles),
  personName: sql<string | null>`COALESCE(
    NULLIF(TRIM(${people.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
  )`.as("person_name"),
};

export function peopleEntityRolesQuery() {
  return db
    .select(peopleEntityRolesSelect)
    .from(peopleEntityRoles)
    .leftJoin(people, eq(people.id, peopleEntityRoles.personId));
}
