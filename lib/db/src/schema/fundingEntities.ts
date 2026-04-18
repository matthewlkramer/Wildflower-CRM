import {
  pgTable,
  text,
  timestamp,
  numeric,
  pgEnum,
  integer,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { individuals } from "./individuals";
import { enthusiasmEnum } from "./individuals";
import { fundingEntityStatusEnum } from "./_enums";

export const fundingEntitySubtypeEnum = pgEnum("funding_entity_subtype", [
  "institutional_foundation",
  "family_foundation",
  "daf_account",
  "government_agency",
  "corporate",
  "501c4",
  "personal_giving_vehicle",
  "family_office_trust",
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
  enthusiasm: enthusiasmEnum("enthusiasm").default("neutral"),
  status: fundingEntityStatusEnum("status").notNull().default("active"),
  parentFundingEntityId: text("parent_funding_entity_id").references(
    (): AnyPgColumn => fundingEntities.id,
    { onDelete: "set null" },
  ),
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
  customFields: jsonb("custom_fields").default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type FundingEntity = typeof fundingEntities.$inferSelect;
export type NewFundingEntity = typeof fundingEntities.$inferInsert;
