import { createHash } from "node:crypto";
import type { ConsentEvidence } from "./newsletterConsentSources";

/** Private, reviewable production import. Conflicts abort rather than overwrite. */
export function newsletterEvidenceSql(
  events: Array<ConsentEvidence & { personId: string }>,
): string {
  const rows = events.map((event) => ({
    id: `newsletter_import_${createHash("sha256").update(event.sourceKey).digest("hex")}`,
    person_id: event.personId,
    event_type: event.eventType,
    occurred_at: event.occurredAt?.toISOString() ?? null,
    source: event.source,
    source_key: event.sourceKey,
    source_url: event.sourceUrl ?? null,
    evidence: event.evidence,
    metadata: event.metadata,
  }));
  const literal = "'" + JSON.stringify(rows).replaceAll("'", "''") + "'";
  // A reviewed, immutable snapshot for the human production cutover. Source
  // conflicts and identity drift abort the transaction via NOT NULL checks.
  const sql = `-- PRIVATE constituent evidence. Review securely; do not commit to GitHub.
BEGIN;
SET LOCAL standard_conforming_strings = on;
WITH input AS (SELECT * FROM jsonb_populate_recordset(NULL::newsletter_preference_events, ${literal}::jsonb))
INSERT INTO newsletter_preference_events (id, person_id, event_type, occurred_at, source, source_key, source_url, evidence, metadata)
SELECT i.id, CASE WHEN EXISTS (SELECT 1 FROM emails e JOIN people p ON p.id=e.person_id WHERE p.id=i.person_id AND p.archived_at IS NULL AND lower(trim(e.email))=i.metadata->>'normalizedEmail') THEN i.person_id ELSE NULL END,
 i.event_type, i.occurred_at, i.source, i.source_key, i.source_url, i.evidence, i.metadata FROM input i ORDER BY i.person_id, i.source_key
ON CONFLICT (source_key) DO UPDATE SET source_key = CASE WHEN
 newsletter_preference_events.person_id = EXCLUDED.person_id AND newsletter_preference_events.event_type = EXCLUDED.event_type AND
 newsletter_preference_events.occurred_at IS NOT DISTINCT FROM EXCLUDED.occurred_at AND newsletter_preference_events.source = EXCLUDED.source AND
 newsletter_preference_events.evidence = EXCLUDED.evidence AND newsletter_preference_events.source_url IS NOT DISTINCT FROM EXCLUDED.source_url
 THEN EXCLUDED.source_key ELSE NULL END;
COMMIT;
`;
  return sql;
}
