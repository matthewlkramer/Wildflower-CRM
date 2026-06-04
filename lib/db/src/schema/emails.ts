import { check, index, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contactValidityEnum, emailTypeEnum } from "./_enums";
import { people } from "./people";
import { organizations } from "./organizations";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { households } from "./households";

export const emails = pgTable(
  "emails",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    type: emailTypeEnum("type"),
    // An email row is owned by exactly one of these four (enforced by the
    // CHECK below). CASCADE: deleting the owning entity removes its email
    // rows.
    personId: text("person_id").references(() => people.id, {
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
    index("emails_person_id_idx").on(t.personId),
    index("emails_organization_id_idx").on(t.organizationId),
    index("emails_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
    index("emails_household_id_idx").on(t.householdId),
    check(
      "emails_exactly_one_owner",
      sql`num_nonnulls(${t.personId}, ${t.organizationId}, ${t.paymentIntermediaryId}, ${t.householdId}) = 1`,
    ),
  ],
);

export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
