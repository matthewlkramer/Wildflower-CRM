import { peopleEntityRoles, people, emails } from "@workspace/db/schema";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { maskName, type Viewer } from "./identityVisibility";

// Shared SELECT shape for people_entity_roles that joins the related
// person row to expose a display name. The COALESCE mirrors the
// pattern used in funders/people primary-contact subqueries:
// prefer full_name, fall back to first+last, NULL if neither has
// non-whitespace content.
//
// personEmail: correlated subquery picking the preferred email for
// the linked person (is_preferred DESC), falling back to any email
// on the person (created_at ASC for a stable choice). NULL if the
// person has no emails.
export const peopleEntityRolesSelect = {
  ...getTableColumns(peopleEntityRoles),
  personName: sql<string | null>`COALESCE(
    NULLIF(TRIM(${people.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
  )`.as("person_name"),
  personEmail: sql<string | null>`(
    SELECT ${emails.email}
    FROM ${emails}
    WHERE ${emails.personId} = ${peopleEntityRoles.personId}
    ORDER BY ${emails.isPreferred} DESC, ${emails.createdAt} ASC
    LIMIT 1
  )`.as("person_email"),
  // Anonymous-masking helpers: carry the linked person's anonymous + owner so
  // consumers can mask personName server-side. Stripped before res.json by
  // maskPeopleEntityRoles so the response shape is unchanged.
  personAnonymous: people.anonymous,
  personOwnerUserId: people.ownerUserId,
};

export function peopleEntityRolesQuery() {
  return db
    .select(peopleEntityRolesSelect)
    .from(peopleEntityRoles)
    .leftJoin(people, eq(people.id, peopleEntityRoles.personId));
}

// Mask each role row's denormalized personName and strip the anonymous/owner
// helper aliases so the JSON response shape is unchanged.
export function maskPeopleEntityRoles<
  T extends {
    personName: string | null;
    personAnonymous: boolean | null;
    personOwnerUserId: string | null;
  },
>(rows: T[], viewer: Viewer) {
  return rows.map(({ personAnonymous, personOwnerUserId, ...rest }) => ({
    ...rest,
    personName: maskName(
      rest.personName,
      { anonymous: personAnonymous, ownerUserId: personOwnerUserId },
      viewer,
    ),
  }));
}
