import { pgTable, text, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { contactOwnerTypeEnum } from "./contactEmails";

export const phoneLabelEnum = pgEnum("phone_label", [
  "mobile",
  "home",
  "work",
  "other",
]);

export const contactPhones = pgTable("contact_phones", {
  id: text("id").primaryKey(),
  ownerType: contactOwnerTypeEnum("owner_type").notNull(),
  ownerId: text("owner_id").notNull(),
  phone: text("phone").notNull(),
  label: phoneLabelEnum("label").default("mobile"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  smsOptedOut: boolean("sms_opted_out").default(false).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ContactPhone = typeof contactPhones.$inferSelect;
export type NewContactPhone = typeof contactPhones.$inferInsert;
