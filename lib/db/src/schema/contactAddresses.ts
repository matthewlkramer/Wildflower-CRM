import { pgTable, text, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { contactOwnerTypeEnum } from "./contactEmails";

export const addressLabelEnum = pgEnum("address_label", [
  "home",
  "work",
  "seasonal",
  "mailing",
  "other",
]);

export const contactAddresses = pgTable("contact_addresses", {
  id: text("id").primaryKey(),
  ownerType: contactOwnerTypeEnum("owner_type").notNull(),
  ownerId: text("owner_id").notNull(),
  line1: text("line1").notNull(),
  line2: text("line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").default("US"),
  metroArea: text("metro_area"),
  label: addressLabelEnum("label").default("home"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  mailOptedOut: boolean("mail_opted_out").default(false).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ContactAddress = typeof contactAddresses.$inferSelect;
export type NewContactAddress = typeof contactAddresses.$inferInsert;
