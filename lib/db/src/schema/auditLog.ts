import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Universal change-tracking ledger. One row per auditable mutation across the
 * core CRM entities (organizations, people, households, opportunities, gifts)
 * plus high-impact actions (merge, bulk operations, archive/unarchive).
 *
 * This is intentionally separate from `bulk_operations`: that table is the
 * detailed per-batch ledger (which ids/fields were touched, partial failures);
 * `audit_log` is the human-readable, entity-scoped timeline. A bulk op emits
 * ONE summary `audit_log` row that references the batch, while `bulk_operations`
 * keeps the row-level detail.
 *
 * `actorUserId` is nullable so system/scheduled mutations (no request user) can
 * still be recorded. `changes` holds field-level `{ field, from, to }` diffs;
 * `metadata` holds free-form context (e.g. merged-from id, batch counts).
 */
export type AuditFieldChange = {
  field: string;
  from: unknown;
  to: unknown;
};

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    summary: text("summary"),
    changes: jsonb("changes").$type<AuditFieldChange[] | null>(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    entityIdx: index("audit_log_entity_idx").on(
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    actorIdx: index("audit_log_actor_idx").on(t.actorUserId, t.createdAt),
    createdIdx: index("audit_log_created_idx").on(t.createdAt),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
