import { check, index, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  entityRoleTypeEnum,
  peopleRoleCurrentEnum,
  peopleEntityRoleConnectionEnum,
} from "./_enums";
import { people } from "./people";
import { organizations } from "./organizations";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { households } from "./households";

export const peopleEntityRoles = pgTable(
  "people_entity_roles",
  {
    id: text("id").primaryKey(),
    // CASCADE: a role row has no meaning without its person; deleting a
    // person removes their role records.
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    entityType: entityRoleTypeEnum("entity_type").notNull(),
    // CASCADE on every entity FK: a role row has no meaning without its
    // entity. The discriminator CHECK below guarantees exactly one of these
    // three columns is populated and that it matches entity_type.
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
    connection: peopleEntityRoleConnectionEnum("connection"),
    notes: text("notes"),
    externalTitleOrRole: text("external_title_or_role"),
    current: peopleRoleCurrentEnum("current").default("current").notNull(),
    // True iff this person is the *present-tense* primary contact for the
    // entity (org / DAF / household). Use this to answer "who should I
    // email about org X right now?". For historical attribution read the
    // opp's or gift's own primary_contact_person_id instead.
    primaryContact: boolean("primary_contact").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("people_entity_roles_person_id_idx").on(t.personId),
    index("people_entity_roles_organization_id_idx").on(t.organizationId),
    index("people_entity_roles_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
    index("people_entity_roles_household_id_idx").on(t.householdId),
    // Discriminator alignment: entity_type names which of the 3 entity FKs
    // must be populated; the other two must be NULL.
    check(
      "per_entity_discriminator",
      sql`
        (${t.entityType} = 'organization' AND ${t.organizationId} IS NOT NULL AND ${t.paymentIntermediaryId} IS NULL AND ${t.householdId} IS NULL)
        OR (${t.entityType} = 'payment_intermediary' AND ${t.paymentIntermediaryId} IS NOT NULL AND ${t.organizationId} IS NULL AND ${t.householdId} IS NULL)
        OR (${t.entityType} = 'household' AND ${t.householdId} IS NOT NULL AND ${t.organizationId} IS NULL AND ${t.paymentIntermediaryId} IS NULL)
      `,
    ),
  ],
);

export type PeopleEntityRole = typeof peopleEntityRoles.$inferSelect;
export type NewPeopleEntityRole = typeof peopleEntityRoles.$inferInsert;
