import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Immutable audit trail of changes to connectionStatus and enthusiasm on
 * people and organizations. Written by the PATCH /people/:id and
 * PATCH /organizations/:id route handlers whenever either field changes.
 *
 * No FK constraints by design — the row is retained even if the linked
 * entity is later deleted. fromValue / toValue store the enum string
 * directly (no DB enum type) so the log never breaks if the set of
 * allowed values changes in the future.
 */
export const connectionEnthusiasmHistory = pgTable(
  "connection_enthusiasm_history",
  {
    id: text("id").primaryKey(),
    /** Discriminator: "person" | "organization" */
    entityType: text("entity_type").notNull(),
    /** Airtable-format record ID of the person or organization. */
    entityId: text("entity_id").notNull(),
    /** Which field changed: "connectionStatus" | "enthusiasm" */
    field: text("field").notNull(),
    /** Value before the change; null when first set from null. */
    fromValue: text("from_value"),
    /** Value after the change; null when cleared. */
    toValue: text("to_value"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    /** CRM users.id of the person who triggered the change. */
    changedByUserId: text("changed_by_user_id").notNull(),
  },
  (t) => [
    index("ceh_entity_idx").on(t.entityType, t.entityId),
    index("ceh_changed_at_idx").on(t.changedAt),
    index("ceh_user_idx").on(t.changedByUserId),
  ],
);

export type ConnectionEnthusiasmHistoryEntry =
  typeof connectionEnthusiasmHistory.$inferSelect;
export type NewConnectionEnthusiasmHistoryEntry =
  typeof connectionEnthusiasmHistory.$inferInsert;
