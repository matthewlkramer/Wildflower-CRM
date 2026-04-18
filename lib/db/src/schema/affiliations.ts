import { pgTable, text, timestamp, boolean, date, pgEnum } from "drizzle-orm/pg-core";
import { individuals } from "./individuals";
import { fundingEntities } from "./fundingEntities";
import { organizations } from "./organizations";

export const affiliationTypeEnum = pgEnum("affiliation_type", [
  "employee",
  "board_member",
  "trustee",
  "advisor",
  "founder",
  "volunteer",
  "other",
]);

export const affiliations = pgTable("affiliations", {
  id: text("id").primaryKey(),
  individualId: text("individual_id")
    .notNull()
    .references(() => individuals.id, { onDelete: "cascade" }),
  fundingEntityId: text("funding_entity_id").references(
    () => fundingEntities.id,
    { onDelete: "cascade" },
  ),
  organizationId: text("organization_id").references(
    () => organizations.id,
    { onDelete: "cascade" },
  ),
  role: text("role"),
  affiliationType: affiliationTypeEnum("affiliation_type").notNull(),
  startDate: date("start_date"),
  endDate: date("end_date"),
  isCurrent: boolean("is_current").default(true).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Affiliation = typeof affiliations.$inferSelect;
export type NewAffiliation = typeof affiliations.$inferInsert;
