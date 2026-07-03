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
 * Durable "these evidence UNITS are really ONE gift" grouping (Plane 2 cleanup
 * op — docs/reconciliation-design.md §4.6b, Decision 7). Generalizes today's
 * `staged_payments.source_group_id` into a first-class, sync-safe association so
 * a grouped set persists and displays as one logical unit BEFORE and AFTER it is
 * matched to a gift, while the underlying evidence rows stay pristine for the
 * sync to re-own (INV-G).
 *
 * A `unit_groups` row is a pure CRM annotation (id + optional label/note + who
 * created it). Membership is POLYMORPHIC — `(evidence_source, source_id)` — the
 * SAME shape the `payment_applications` ledger uses, so grouping never needs a
 * column on three different evidence tables (staged_payments / stripe charges /
 * donorbox donations). `source_id` is a plain text id with NO foreign key
 * (mirroring the staging-table convention, e.g. coding_form_rows) because it is
 * polymorphic across three anchors and must not require a per-source FK.
 *
 * Membership is EXCLUSIVE: a unit belongs to at most one group, enforced by a
 * UNIQUE(evidence_source, source_id). Once grouped, a unit matches ONLY via its
 * group (never individually) — the exclusivity guard the reconciler reads.
 *
 * Rollout note (additive dual-write phase — WS2): the group/ungroup endpoints
 * dual-write this table ALONGSIDE `staged_payments.source_group_id`; the
 * matcher/approve/revert paths are NOT yet flipped to read it (that is the WS1
 * mechanism collapse, strictly after this table's PROD parity). Backfilled from
 * today's `source_group_id` (>= 2 members) by migration 0088.
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
