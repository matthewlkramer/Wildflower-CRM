import { sql, type SQL, type AnyColumn } from "drizzle-orm";

// Canonical person display-name SQL, shared by every endpoint that emits a
// person name the client renders. Mirrors the client's `personDisplayName()`
// fallback chain (and the people list's default sort key):
//   preferred(nickname)+last → full_name → first+last → NULL
// The nickname column holds the person's *preferred* name (the name they
// actually go by, e.g. "Tommy" for "Thomas Barrett III"), so when it is set
// it replaces the first name in the display: "Tommy Barrett". The formal
// full/first/last fields remain the source for exports and the detail form.
// The final "Person <id>" fallback stays client-side — server projections
// return NULL when no name-ish field has content, and each consumer picks its
// own placeholder.
//
// Accepts the column set rather than the table so it works with `alias()`d
// people joins (e.g. the opportunities primary contact).
export interface PersonNameColumns {
  fullName: AnyColumn;
  firstName: AnyColumn;
  lastName: AnyColumn;
  nickname: AnyColumn;
}

export function personDisplayNameSql(p: PersonNameColumns): SQL<string | null> {
  return sql<string | null>`COALESCE(
    CASE WHEN NULLIF(TRIM(${p.nickname}), '') IS NOT NULL
         THEN NULLIF(TRIM(CONCAT_WS(' ', ${p.nickname}, ${p.lastName})), '') END,
    NULLIF(TRIM(${p.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${p.firstName}, ${p.lastName})), '')
  )`;
}
