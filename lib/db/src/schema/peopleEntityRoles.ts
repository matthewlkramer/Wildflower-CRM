import { check, index, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  entityRoleTypeEnum,
  peopleRoleCurrentEnum,
  peopleEntityRoleConnectionEnum,
} from "./_enums";
import { people } from "./people";
import { funders } from "./funders";
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
    // four columns is populated and that it matches entity_type.
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
    connection: peopleEntityRoleConnectionEnum("connection"),
    notes: text("notes"),
    externalTitleOrRole: text("external_title_or_role"),
    current: peopleRoleCurrentEnum("current").default("current").notNull(),
    primaryContact: boolean("primary_contact").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("people_entity_roles_person_id_idx").on(t.personId),
    index("people_entity_roles_funder_id_idx").on(t.funderId),
    index("people_entity_roles_organization_id_idx").on(t.organizationId),
    index("people_entity_roles_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
    index("people_entity_roles_household_id_idx").on(t.householdId),
    // Discriminator alignment: entity_type names which of the 4 entity FKs
    // must be populated; the other three must be NULL. Prevents the role
    // row from claiming to be a "funder role" while actually pointing at an
    // organization, etc.
    check(
      "per_entity_discriminator",
      sql`
        (${t.entityType} = 'funder' AND ${t.funderId} IS NOT NULL AND ${t.organizationId} IS NULL AND ${t.paymentIntermediaryId} IS NULL AND ${t.householdId} IS NULL)
        OR (${t.entityType} = 'non_funding_organization' AND ${t.organizationId} IS NOT NULL AND ${t.funderId} IS NULL AND ${t.paymentIntermediaryId} IS NULL AND ${t.householdId} IS NULL)
        OR (${t.entityType} = 'payment_intermediary' AND ${t.paymentIntermediaryId} IS NOT NULL AND ${t.funderId} IS NULL AND ${t.organizationId} IS NULL AND ${t.householdId} IS NULL)
        OR (${t.entityType} = 'household' AND ${t.householdId} IS NOT NULL AND ${t.funderId} IS NULL AND ${t.organizationId} IS NULL AND ${t.paymentIntermediaryId} IS NULL)
      `,
    ),
  ],
);

export type PeopleEntityRole = typeof peopleEntityRoles.$inferSelect;
export type NewPeopleEntityRole = typeof peopleEntityRoles.$inferInsert;
