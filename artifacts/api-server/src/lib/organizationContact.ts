import { sql, type SQLWrapper } from "drizzle-orm";

/** Canonical organization contact display. No copy is persisted on organizations. */
export function organizationPrimaryEmail(organizationId: SQLWrapper) {
  return sql<string | null>`(
    SELECT e.email FROM emails e
    WHERE e.organization_id = ${organizationId} AND e.validity <> 'invalid'
    ORDER BY e.is_preferred DESC, e.created_at ASC, e.id ASC
    LIMIT 1
  )`;
}

/** Identity matching considers every usable contact address, not only the preferred one. */
export function organizationEmails(organizationId: SQLWrapper) {
  return sql<string[]>`ARRAY(
    SELECT e.email FROM emails e
    WHERE e.organization_id = ${organizationId} AND e.validity <> 'invalid'
    ORDER BY e.id
  )`;
}
