import {
  pgTable,
  text,
  timestamp,
  numeric,
  pgEnum,
  integer,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { individuals } from "./individuals";

export const fundingEntitySubtypeEnum = pgEnum("funding_entity_subtype", [
  "institutional_foundation",
  "family_foundation",
  "daf_account",
  "government_agency",
  "corporate",
]);

export const institutionalCultivationStageEnum = pgEnum(
  "institutional_cultivation_stage",
  [
    "prospect",
    "research",
    "letter_of_inquiry",
    "proposal",
    "decision_pending",
    "funded",
    "stewardship",
    "declined",
    "inactive",
  ],
);

export const governmentCultivationStageEnum = pgEnum(
  "government_cultivation_stage",
  [
    "rfp_watching",
    "rfp_active",
    "submitted",
    "awarded",
    "active_grant",
    "closed",
    "not_applicable",
  ],
);

export const fundingEntities = pgTable("funding_entities", {
  id: text("id").primaryKey(),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name"),
  subtype: fundingEntitySubtypeEnum("subtype").notNull(),
  ein: text("ein"),
  website: text("website"),
  primaryContactId: text("primary_contact_id").references(
    () => individuals.id,
    { onDelete: "set null" },
  ),
  relationshipOwnerUserId: text("relationship_owner_user_id").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  institutionalCultivationStage: institutionalCultivationStageEnum(
    "institutional_cultivation_stage",
  ),
  governmentCultivationStage: governmentCultivationStageEnum(
    "government_cultivation_stage",
  ),
  enthusiasm: text("enthusiasm"),
  typicalGrantSizeMin: numeric("typical_grant_size_min", {
    precision: 15,
    scale: 2,
  }),
  typicalGrantSizeMax: numeric("typical_grant_size_max", {
    precision: 15,
    scale: 2,
  }),
  totalGiving: numeric("total_giving", { precision: 15, scale: 2 }).default(
    "0",
  ),
  lastGiftDate: timestamp("last_gift_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const fundingEntityPeople = pgTable("funding_entity_people", {
  id: text("id").primaryKey(),
  fundingEntityId: text("funding_entity_id")
    .notNull()
    .references(() => fundingEntities.id, { onDelete: "cascade" }),
  individualId: text("individual_id")
    .notNull()
    .references(() => individuals.id, { onDelete: "cascade" }),
  role: text("role"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type FundingEntity = typeof fundingEntities.$inferSelect;
export type NewFundingEntity = typeof fundingEntities.$inferInsert;
export type FundingEntityPerson = typeof fundingEntityPeople.$inferSelect;
