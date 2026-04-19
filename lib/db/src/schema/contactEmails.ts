import { pgTable, text, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";

export const contactOwnerTypeEnum = pgEnum("contact_owner_type", [
  "individual",
  "household",
  "funding_entity",
  "organization",
]);

export const emailLabelEnum = pgEnum("email_label", [
  "personal",
  "work",
  "school",
  "other",
]);

export const contactStatusEnum = pgEnum("contact_status", [
  "current",
  "former",
  "unknown",
]);

export const contactEmails = pgTable("contact_emails", {
  id: text("id").primaryKey(),
  ownerType: contactOwnerTypeEnum("owner_type").notNull(),
  ownerId: text("owner_id").notNull(),
  email: text("email").notNull(),
  label: emailLabelEnum("label").default("personal"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  isBounced: boolean("is_bounced").default(false).notNull(),
  optedOut: boolean("opted_out").default(false).notNull(),
  status: contactStatusEnum("status").default("current").notNull(),
  endedAt: timestamp("ended_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ContactEmail = typeof contactEmails.$inferSelect;
export type NewContactEmail = typeof contactEmails.$inferInsert;
