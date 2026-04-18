import {
  pgTable,
  text,
  timestamp,
  boolean,
  numeric,
  date,
  pgEnum,
  jsonb,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const donorCultivationStageEnum = pgEnum("donor_cultivation_stage", [
  "pre_qualified",
  "qualified",
  "have_path_to_connect",
  "connected",
  "in_relationship",
  "lapsed_relationship",
]);

export const institutionalContactStageEnum = pgEnum(
  "institutional_contact_stage",
  [
    "uncontacted",
    "initial_outreach",
    "connected",
    "relationship_active",
    "lapsed",
  ],
);

export const enthusiasmEnum = pgEnum("enthusiasm", [
  "active_opposition",
  "unsupportive",
  "skeptical",
  "neutral",
  "warm",
  "supportive",
  "advocate",
]);

export const capacityRatingEnum = pgEnum("capacity_rating", [
  "tier_1k_10k",
  "tier_10k_50k",
  "tier_50k_250k",
  "tier_250k_1m",
  "tier_1m_plus",
]);

export const individuals = pgTable("individuals", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  preferredName: text("preferred_name"),
  pronouns: text("pronouns"),
  linkedinUrl: text("linkedin_url"),
  relationshipOwnerUserId: text("relationship_owner_user_id").references(
    () => users.id,
    { onDelete: "set null" },
  ),
  strategyUserId: text("strategy_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  donorCultivationStage: donorCultivationStageEnum(
    "donor_cultivation_stage",
  ).default("pre_qualified"),
  institutionalContactStage: institutionalContactStageEnum(
    "institutional_contact_stage",
  ),
  enthusiasm: enthusiasmEnum("enthusiasm").default("neutral"),
  capacityRating: capacityRatingEnum("capacity_rating"),
  lastMoveDate: timestamp("last_move_date"),
  lastGiftDate: timestamp("last_gift_date"),
  lastGiftAmount: numeric("last_gift_amount", { precision: 15, scale: 2 }),
  totalGiving: numeric("total_giving", { precision: 15, scale: 2 }).default(
    "0",
  ),
  deceasedDate: date("deceased_date"),
  birthday: date("birthday"),
  customFields: jsonb("custom_fields").default({}).notNull(),
  emailOptOut: boolean("email_opt_out").default(false).notNull(),
  callOptOut: boolean("call_opt_out").default(false).notNull(),
  mailOptOut: boolean("mail_opt_out").default(false).notNull(),
  textOptOut: boolean("text_opt_out").default(false).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Individual = typeof individuals.$inferSelect;
export type NewIndividual = typeof individuals.$inferInsert;
