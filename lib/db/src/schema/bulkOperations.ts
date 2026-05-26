import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Audit log of bulk-update operations. One row per call to a
 * `POST /<entity>/bulk-update` endpoint, regardless of how many records
 * were touched. Forward-only — fields the user did not opt into are
 * never overwritten — so the audit captures exactly which fields were
 * sent and which ids were targeted.
 *
 * `succeededIds` and `failedIds` are stored separately so the audit
 * shows the realized effect (partial failures don't poison the log).
 */
export const bulkOperations = pgTable(
  "bulk_operations",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    entity: text("entity").notNull(),
    fields: text("fields").array().notNull(),
    targetIds: text("target_ids").array().notNull(),
    succeededIds: text("succeeded_ids").array().notNull(),
    failedIds: text("failed_ids").array().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    actorIdx: index("bulk_operations_actor_idx").on(t.actorUserId, t.createdAt),
    entityIdx: index("bulk_operations_entity_idx").on(t.entity, t.createdAt),
  }),
);

export type BulkOperation = typeof bulkOperations.$inferSelect;
export type NewBulkOperation = typeof bulkOperations.$inferInsert;
