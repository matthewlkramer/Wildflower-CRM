import { index, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { contactValidityEnum, phoneTypeEnum } from "./_enums";
import { people } from "./people";

// NOTE: phone_numbers currently only supports a person_id owner, unlike
// emails/addresses which can attach to all 5 entity types. If you ever
// need a phone for a funder / org / DAF, extend this table with the same
// 5-owner pattern and an exactly-one CHECK.
export const phoneNumbers = pgTable("phone_numbers", {
  id: text("id").primaryKey(),
  phoneNumber: text("phone_number").notNull(),
  type: phoneTypeEnum("type"),
  // CASCADE: a phone has no meaning without its owning person.
  personId: text("person_id")
    .notNull()
    .references(() => people.id, { onDelete: "cascade" }),
  validity: contactValidityEnum("validity").default("unknown").notNull(),
  isPreferred: boolean("is_preferred").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("phone_numbers_person_id_idx").on(t.personId),
]);

export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type NewPhoneNumber = typeof phoneNumbers.$inferInsert;
