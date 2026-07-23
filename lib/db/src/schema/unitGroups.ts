import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { paymentApplicationEvidenceSourceEnum } from "./_enums";
import { users } from "./users";

/**
 * @deprecated RETIRED — docs/adr-linear-money-model.md §7 step 3.
 *
 * Unit grouping ("these evidence UNITS are really ONE gift") is replaced by
 * the linear money model: multi-match books one counted
 * `payment_applications` ledger row per member, and those ledger rows alone
 * express the combined outcome. NOTHING reads or writes these tables anymore
 * — no route, service, derivation, or frontend path. The group endpoints are
 * 410 tombstones (`group_creation_retired`).
 *
 * The schema definitions are kept ONLY so the existing prod rows (legacy
 * groups formed before the retirement) survive until §7 step 4, which
 * verifies every legacy member is representable as counted ledger rows and
 * then DROPS both tables via a reviewed migration. Do not add new readers or
 * writers; do not revive group semantics.
 */
export const unitGroups = pgTable("unit_groups", {
  // Deterministic `ug_<source_group_id>` when created from a staged-payment
  // source group, so the runtime dual-write and the 0088 backfill converge on
  // the SAME id (idempotent).
  id: text("id").primaryKey(),
  // Optional human label for the group (e.g. "Smith $1M restriction split").
  label: text("label"),
  // Optional free-text note.
  note: text("note"),
  // Who formed the group (audit). SET NULL on user delete.
  createdByUserId: text("created_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Polymorphic membership of `unit_groups`. One row per evidence unit in a group.
 * `(evidence_source, source_id)` is UNIQUE — a unit belongs to at most one group
 * (exclusivity). `group_id` cascades: dissolving a group removes its membership.
 */
export const unitGroupMembers = pgTable(
  "unit_group_members",
  {
    // Deterministic `ugm_<source_id>` (source_id is globally unique across a
    // single anchor and a unit is in at most one group) so re-runs are no-ops.
    id: text("id").primaryKey(),
    groupId: text("group_id")
      .notNull()
      .references(() => unitGroups.id, { onDelete: "cascade" }),
    evidenceSource:
      paymentApplicationEvidenceSourceEnum("evidence_source").notNull(),
    sourceId: text("source_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    // Exclusivity: a unit belongs to at most one group.
    uniqueIndex("unit_group_members_source_uq").on(
      t.evidenceSource,
      t.sourceId,
    ),
    index("unit_group_members_group_id_idx").on(t.groupId),
  ],
);

export type UnitGroup = typeof unitGroups.$inferSelect;
export type NewUnitGroup = typeof unitGroups.$inferInsert;
export type UnitGroupMember = typeof unitGroupMembers.$inferSelect;
export type NewUnitGroupMember = typeof unitGroupMembers.$inferInsert;
