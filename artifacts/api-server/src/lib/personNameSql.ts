import { sql, type SQL, type AnyColumn } from "drizzle-orm";

// Canonical person display-name SQL, shared by every endpoint that emits a
// person name the client renders. Mirrors the client's `personDisplayName()`
// fallback chain (and the people list's default sort key):
//   full_name → first+last → nickname → NULL
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
    NULLIF(TRIM(${p.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${p.firstName}, ${p.lastName})), ''),
    NULLIF(TRIM(${p.nickname}), '')
  )`;
}
