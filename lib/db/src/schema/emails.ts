import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { contactValidityEnum, emailTypeEnum } from "./_enums";

export const emails = pgTable("emails", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  email: text("email").notNull(),
  type: emailTypeEnum("type"),
  personId: text("person_id"),
  validity: contactValidityEnum("validity").default("unknown").notNull(),
  isPreferred: boolean("is_preferred").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
