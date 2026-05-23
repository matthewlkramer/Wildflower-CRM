import { check, index, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contactValidityEnum, phoneTypeEnum } from "./_enums";
import { people } from "./people";
import { funders } from "./funders";
import { organizations } from "./organizations";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { households } from "./households";

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: text("id").primaryKey(),
    phoneNumber: text("phone_number").notNull(),
    type: phoneTypeEnum("type"),
    // A phone row is owned by exactly one of these five (enforced by the
    // CHECK below). Mirrors emails/addresses so funder / org / household /
    // payment-intermediary main lines can be stored without inventing a
    // fake person. CASCADE: deleting the owning entity removes its phones.
    personId: text("person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    funderId: text("funder_id").references(() => funders.id, {
      onDelete: "cascade",
    }),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    paymentIntermediaryId: text("payment_intermediary_id").references(
      () => paymentIntermediaries.id,
      { onDelete: "cascade" },
    ),
    householdId: text("household_id").references(() => households.id, {
      onDelete: "cascade",
    }),
    validity: contactValidityEnum("validity").default("unknown").notNull(),
    isPreferred: boolean("is_preferred").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("phone_numbers_person_id_idx").on(t.personId),
    index("phone_numbers_funder_id_idx").on(t.funderId),
    index("phone_numbers_organization_id_idx").on(t.organizationId),
    index("phone_numbers_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
    index("phone_numbers_household_id_idx").on(t.householdId),
    check(
      "phone_numbers_exactly_one_owner",
      sql`num_nonnulls(${t.personId}, ${t.funderId}, ${t.organizationId}, ${t.paymentIntermediaryId}, ${t.householdId}) = 1`,
    ),
  ],
);

export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type NewPhoneNumber = typeof phoneNumbers.$inferInsert;
