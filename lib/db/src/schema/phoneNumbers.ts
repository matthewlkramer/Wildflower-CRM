import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { contactValidityEnum, phoneTypeEnum } from "./_enums";

export const phoneNumbers = pgTable("phone_numbers", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  phoneNumber: text("phone_number").notNull(),
  type: phoneTypeEnum("type"),
  personId: text("person_id"),
  validity: contactValidityEnum("validity").default("unknown").notNull(),
  isPreferred: boolean("is_preferred").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type NewPhoneNumber = typeof phoneNumbers.$inferInsert;
