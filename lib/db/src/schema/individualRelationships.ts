import { pgTable, text, timestamp, boolean, date, pgEnum } from "drizzle-orm/pg-core";
import { individuals } from "./individuals";

export const individualRelationshipTypeEnum = pgEnum(
  "individual_relationship_type",
  [
    "spouse",
    "ex_spouse",
    "partner",
    "parent",
    "child",
    "sibling",
    "in_law",
    "donor_advisor",
    "assistant_to",
    "referred_by",
    "other",
  ],
);

export const individualRelationships = pgTable("individual_relationships", {
  id: text("id").primaryKey(),
  fromIndividualId: text("from_individual_id")
    .notNull()
    .references(() => individuals.id, { onDelete: "cascade" }),
  toIndividualId: text("to_individual_id")
    .notNull()
    .references(() => individuals.id, { onDelete: "cascade" }),
  relationshipType: individualRelationshipTypeEnum("relationship_type").notNull(),
  startDate: date("start_date"),
  endDate: date("end_date"),
  isCurrent: boolean("is_current").default(true).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type IndividualRelationship = typeof individualRelationships.$inferSelect;
export type NewIndividualRelationship = typeof individualRelationships.$inferInsert;
