import {
  pgTable,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { entities } from "./entities";

/**
 * Admin-editable per-entity revenue-coding defaults (fiscal-sponsee "SPO" rules)
 * from the CFO "Revenue Extractor" spec. Keyed on the fund `entityId` — no
 * schema flag on entities.
 *
 * Mirrors the QuickBooks-handling-rules pattern: a code SEED
 * (`SEED_ENTITY_CODING_RULES` in `@workspace/api-zod`) reproduces today's
 * behavior, a migration seeds the DB, a fidelity test keeps the seed and the
 * lib in lockstep, and admins can then edit without a code change.
 *
 *   forceRestricted — treat the gift as purpose-restricted regardless of donor
 *                     language (fiscal sponsees are always restricted).
 *   location        — one of the closed Location list values (SPO / Loans).
 *   revenueClass    — Suggested Class (only BWF / Charter use General Operations).
 */
export const entityCodingRules = pgTable("entity_coding_rules", {
  entityId: text("entity_id")
    .primaryKey()
    .references(() => entities.id, { onDelete: "cascade" }),
  forceRestricted: boolean("force_restricted").notNull().default(false),
  location: text("location"),
  revenueClass: text("revenue_class"),
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type EntityCodingRule = typeof entityCodingRules.$inferSelect;
export type NewEntityCodingRule = typeof entityCodingRules.$inferInsert;
