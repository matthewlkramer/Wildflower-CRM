import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { people } from "./people";
import { users } from "./users";

/** Evidence is authoritative. The two people flags are read-only projections
 * maintained by the database trigger in migration 0247, never independent inputs. */
export const newsletterPreferenceEvents = pgTable(
  "newsletter_preference_events",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceUrl: text("source_url"),
    evidence: text("evidence").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    recordedByUserId: text("recorded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("newsletter_preference_source_key_uq").on(t.sourceKey),
    index("newsletter_preference_person_idx").on(t.personId, t.recordedAt),
    index("newsletter_preference_actor_idx").on(t.recordedByUserId),
    check(
      "newsletter_preference_type_ck",
      sql`${t.eventType} IN ('consent_given', 'staff_added', 'staff_removed', 'opted_out', 'legacy_selected', 'legacy_opted_out')`,
    ),
    check(
      "newsletter_preference_evidence_ck",
      sql`length(trim(${t.evidence})) > 0 AND length(trim(${t.source})) > 0`,
    ),
  ],
);
