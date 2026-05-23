import {
  type AnyPgColumn,
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import {
  giftTypeEnum,
  giftPaymentMethodEnum,
  giftAllocationTypeEnum,
  intendedUsageEnum,
} from "./_enums";
import { funders } from "./funders";
import { people } from "./people";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { users } from "./users";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";
import { schools } from "./schools";

export const giftsAndPayments = pgTable("gifts_and_payments", {
  id: text("id").primaryKey(),
  legacyGiftId: text("legacy_gift_id"),
  name: text("name"),
  details: text("details"),
  dateReceived: date("date_received"),
  paymentMethod: giftPaymentMethodEnum("payment_method"),
  amount: numeric("amount", { precision: 14, scale: 2 }),
  // RESTRICT: the funder is the giver of record.
  funderId: text("funder_id").references(() => funders.id, {
    onDelete: "restrict",
  }),
  // RESTRICT: the individual giver is part of the money-trail record.
  individualGiverPersonId: text("individual_giver_person_id").references(
    () => people.id,
    { onDelete: "restrict" },
  ),
  type: giftTypeEnum("type"),
  // RESTRICT: a payment must keep its link to the pledge it pays.
  paymentOnPledgeId: text("payment_on_pledge_id").references(
    () => opportunitiesAndPledges.id,
    { onDelete: "restrict" },
  ),
  // SET NULL: advisor is a soft pointer.
  advisorPersonId: text("advisor_person_id").references(() => people.id, {
    onDelete: "set null",
  }),
  grantYear: text("grant_year"),
  // Self-ref to the gift this one matches. SET NULL: deleting the original
  // shouldn't cascade-delete the matching gift; just clear the pointer.
  giftBeingMatchedId: text("gift_being_matched_id").references(
    (): AnyPgColumn => giftsAndPayments.id,
    { onDelete: "set null" },
  ),
  // SET NULL: primary contact is a soft pointer.
  primaryContactPersonId: text("primary_contact_person_id").references(
    () => people.id,
    { onDelete: "set null" },
  ),
  // RESTRICT: the intermediary (DAF/giving platform) is part of the
  // financial record.
  paymentIntermediaryId: text("payment_intermediary_id").references(
    () => paymentIntermediaries.id,
    { onDelete: "restrict" },
  ),
  // RESTRICT + archive workflow on users.
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  // TODO (#4 in data-structures review): rename close_date →
  // projected_close_date and completed_date → actual_completion_date for
  // consistency with opportunities_and_pledges.
  closeDate: date("close_date"),
  completedDate: date("completed_date"),
  allocationType: giftAllocationTypeEnum("allocation_type"),
  entityId: text("entity_id").references(() => entities.id, {
    onDelete: "restrict",
  }),
  intendedUsage: intendedUsageEnum("intended_usage"),
  fundableProjectId: text("fundable_project_id").references(
    () => fundableProjects.id,
    { onDelete: "restrict" },
  ),
  designatedToSchool: boolean("designated_to_school").default(false).notNull(),
  // RESTRICT: schools are synced from Airtable; the sync now upserts
  // (never deletes), so this only fires if someone manually deletes a
  // school that has gift refs — which should require explicit cleanup
  // first.
  schoolRecipientId: text("school_recipient_id").references(() => schools.id, {
    onDelete: "restrict",
  }),
  spendingStartDate: date("spending_start_date"),
  spendingEndDate: date("spending_end_date"),
  // Array of regions.id values. Array columns can't carry native FK
  // constraints; API layer enforces.
  regionIds: text("region_ids").array(),
  tags: text("tags"),
  createdAtFromAirtable: timestamp("created_at_from_airtable"),
  updatedAtFromAirtable: timestamp("updated_at_from_airtable"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("gifts_and_payments_funder_id_idx").on(t.funderId),
  index("gifts_and_payments_individual_giver_person_id_idx").on(t.individualGiverPersonId),
  index("gifts_and_payments_payment_on_pledge_id_idx").on(t.paymentOnPledgeId),
  index("gifts_and_payments_advisor_person_id_idx").on(t.advisorPersonId),
  index("gifts_and_payments_gift_being_matched_id_idx").on(t.giftBeingMatchedId),
  index("gifts_and_payments_primary_contact_person_id_idx").on(t.primaryContactPersonId),
  index("gifts_and_payments_payment_intermediary_id_idx").on(t.paymentIntermediaryId),
  index("gifts_and_payments_owner_user_id_idx").on(t.ownerUserId),
  index("gifts_and_payments_entity_id_idx").on(t.entityId),
  index("gifts_and_payments_fundable_project_id_idx").on(t.fundableProjectId),
  index("gifts_and_payments_school_recipient_id_idx").on(t.schoolRecipientId),
  index("gifts_and_payments_region_ids_gin_idx").using("gin", t.regionIds),
]);

export type GiftOrPayment = typeof giftsAndPayments.$inferSelect;
export type NewGiftOrPayment = typeof giftsAndPayments.$inferInsert;
