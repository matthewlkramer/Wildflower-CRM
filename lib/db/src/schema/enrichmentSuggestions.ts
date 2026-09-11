import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export type EnrichmentSuggestedValue = {
  regionId: string;
  label: string;
};

/**
 * Human-reviewed suggestions derived from existing CRM evidence. Entity IDs
 * are polymorphic, so their referential integrity is enforced by the service
 * after `entity_type` selects the people or organizations table.
 */
export const enrichmentSuggestions = pgTable(
  "enrichment_suggestions",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    fieldName: text("field_name").notNull(),
    suggestedValue: jsonb("suggested_value")
      .$type<EnrichmentSuggestedValue>()
      .notNull(),
    sourceLabel: text("source_label").notNull(),
    sourceDetail: text("source_detail"),
    status: text("status").default("pending").notNull(),
    resolvedAt: timestamp("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "enrichment_suggestions_entity_type_ck",
      sql`${t.entityType} IN ('person', 'organization')`,
    ),
    check(
      "enrichment_suggestions_status_ck",
      sql`${t.status} IN ('pending', 'accepted', 'dismissed')`,
    ),
    uniqueIndex("enrichment_suggestions_pending_uq")
      .on(t.entityType, t.entityId, t.fieldName)
      .where(sql`${t.status} = 'pending'`),
    index("enrichment_suggestions_entity_idx").on(
      t.entityType,
      t.entityId,
      t.status,
    ),
    index("enrichment_suggestions_resolved_by_idx").on(t.resolvedByUserId),
  ],
);

export type EnrichmentSuggestion = typeof enrichmentSuggestions.$inferSelect;
export type NewEnrichmentSuggestion = typeof enrichmentSuggestions.$inferInsert;
