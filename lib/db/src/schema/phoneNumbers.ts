import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { contactCurrentEnum } from "./_enums";

export const phoneNumbers = pgTable("phone_numbers", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  phoneNumber: text("phone_number").notNull(),
  type: text("type"),
  personId: text("person_id"),
  current: contactCurrentEnum("current").default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type NewPhoneNumber = typeof phoneNumbers.$inferInsert;
