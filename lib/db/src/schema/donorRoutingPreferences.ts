import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { people } from "./people";
import { households } from "./households";
import { organizations } from "./organizations";
import { users } from "./users";

export type DonorRecordKind = "individual" | "household" | "organization";
export type StoredDonorRoutingMode = "target" | "ask";

/**
 * Explicit exceptions to the implicit donor-routing default.
 *
 * No row means "use this record". A row either points to another donor record
 * or says to ask each time. Keeping self-routing implicit avoids millions of
 * redundant rows while still giving every donor record an effective pathway.
 */
export const donorRoutingPreferences = pgTable(
  "donor_routing_preferences",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind").$type<DonorRecordKind>().notNull(),
    sourcePersonId: text("source_person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    sourceHouseholdId: text("source_household_id").references(
      () => households.id,
      { onDelete: "cascade" },
    ),
    sourceOrganizationId: text("source_organization_id").references(
      () => organizations.id,
      { onDelete: "cascade" },
    ),
    mode: text("mode").$type<StoredDonorRoutingMode>().notNull(),
    targetKind: text("target_kind").$type<DonorRecordKind>(),
    targetPersonId: text("target_person_id").references(() => people.id, {
      onDelete: "restrict",
    }),
    targetHouseholdId: text("target_household_id").references(
      () => households.id,
      { onDelete: "restrict" },
    ),
    targetOrganizationId: text("target_organization_id").references(
      () => organizations.id,
      { onDelete: "restrict" },
    ),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "donor_routing_source_shape_ck",
      sql`num_nonnulls(${t.sourcePersonId}, ${t.sourceHouseholdId}, ${t.sourceOrganizationId}) = 1
        AND (
          (${t.sourceKind} = 'individual' AND ${t.sourcePersonId} IS NOT NULL)
          OR (${t.sourceKind} = 'household' AND ${t.sourceHouseholdId} IS NOT NULL)
          OR (${t.sourceKind} = 'organization' AND ${t.sourceOrganizationId} IS NOT NULL)
        )`,
    ),
    check(
      "donor_routing_target_shape_ck",
      sql`(
          ${t.mode} = 'ask'
          AND ${t.targetKind} IS NULL
          AND num_nonnulls(${t.targetPersonId}, ${t.targetHouseholdId}, ${t.targetOrganizationId}) = 0
        ) OR (
          ${t.mode} = 'target'
          AND ${t.targetKind} IS NOT NULL
          AND num_nonnulls(${t.targetPersonId}, ${t.targetHouseholdId}, ${t.targetOrganizationId}) = 1
          AND (
            (${t.targetKind} = 'individual' AND ${t.targetPersonId} IS NOT NULL)
            OR (${t.targetKind} = 'household' AND ${t.targetHouseholdId} IS NOT NULL)
            OR (${t.targetKind} = 'organization' AND ${t.targetOrganizationId} IS NOT NULL)
          )
        )`,
    ),
    uniqueIndex("donor_routing_source_person_uq")
      .on(t.sourcePersonId)
      .where(sql`${t.sourcePersonId} IS NOT NULL`),
    uniqueIndex("donor_routing_source_household_uq")
      .on(t.sourceHouseholdId)
      .where(sql`${t.sourceHouseholdId} IS NOT NULL`),
    uniqueIndex("donor_routing_source_org_uq")
      .on(t.sourceOrganizationId)
      .where(sql`${t.sourceOrganizationId} IS NOT NULL`),
    index("donor_routing_target_person_idx").on(t.targetPersonId),
    index("donor_routing_target_household_idx").on(t.targetHouseholdId),
    index("donor_routing_target_org_idx").on(t.targetOrganizationId),
  ],
);

export type DonorRoutingPreference =
  typeof donorRoutingPreferences.$inferSelect;
export type NewDonorRoutingPreference =
  typeof donorRoutingPreferences.$inferInsert;
