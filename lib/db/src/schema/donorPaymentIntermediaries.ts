import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { organizations } from "./organizations";
import { people } from "./people";
import { households } from "./households";

// A donor's explicit "gives through" link to a payment intermediary (e.g. a
// DAF). Unifies all three donor types via the same donor-XOR convention used
// by gifts_and_payments / opportunities_and_pledges: exactly one of
// {organizationId, individualGiverPersonId, householdId} is populated per row.
// Many-to-many: a donor can give through several intermediaries. This is the
// logged source of truth; per-gift payment_intermediary_id remains the
// transaction-level record, and gift-derived intermediaries are surfaced
// separately as an un-logged hint.
export const donorPaymentIntermediaries = pgTable(
  "donor_payment_intermediaries",
  {
    id: text("id").primaryKey(),
    // CASCADE: the link has no meaning without its intermediary.
    paymentIntermediaryId: text("payment_intermediary_id")
      .notNull()
      .references(() => paymentIntermediaries.id, { onDelete: "cascade" }),
    // Donor XOR (CHECK below). CASCADE on each: the link has no meaning
    // without its donor.
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    individualGiverPersonId: text("individual_giver_person_id").references(
      () => people.id,
      { onDelete: "cascade" },
    ),
    householdId: text("household_id").references(() => households.id, {
      onDelete: "cascade",
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("donor_payment_intermediaries_payment_intermediary_id_idx").on(
      t.paymentIntermediaryId,
    ),
    index("donor_payment_intermediaries_organization_id_idx").on(
      t.organizationId,
    ),
    index("donor_payment_intermediaries_individual_giver_person_id_idx").on(
      t.individualGiverPersonId,
    ),
    index("donor_payment_intermediaries_household_id_idx").on(t.householdId),
    // Donor XOR: exactly one donor FK populated.
    check(
      "dpi_donor_xor",
      sql`num_nonnulls(${t.organizationId}, ${t.individualGiverPersonId}, ${t.householdId}) = 1`,
    ),
    // Dedupe (donor, intermediary) per donor type. Partial because only one
    // donor FK is non-null per row.
    uniqueIndex("dpi_unique_org_pi")
      .on(t.organizationId, t.paymentIntermediaryId)
      .where(sql`${t.organizationId} IS NOT NULL`),
    uniqueIndex("dpi_unique_person_pi")
      .on(t.individualGiverPersonId, t.paymentIntermediaryId)
      .where(sql`${t.individualGiverPersonId} IS NOT NULL`),
    uniqueIndex("dpi_unique_household_pi")
      .on(t.householdId, t.paymentIntermediaryId)
      .where(sql`${t.householdId} IS NOT NULL`),
  ],
);

export type DonorPaymentIntermediary =
  typeof donorPaymentIntermediaries.$inferSelect;
export type NewDonorPaymentIntermediary =
  typeof donorPaymentIntermediaries.$inferInsert;
