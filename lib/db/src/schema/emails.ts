import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { contactCurrentEnum } from "./_enums";

export const emails = pgTable("emails", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  email: text("email").notNull(),
  type: text("type"),
  personId: text("person_id"),
  current: contactCurrentEnum("current").default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
