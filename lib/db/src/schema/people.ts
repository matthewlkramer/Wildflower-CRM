import {
  type AnyPgColumn,
  index,
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  date,
} from "drizzle-orm/pg-core";
import { pronounsEnum } from "./_enums";
import { users } from "./users";
import { regions } from "./regions";

export const people = pgTable("people", {
  id: text("id").primaryKey(),
  prefix: text("prefix"),
  firstName: text("first_name"),
  nickname: text("nickname"),
  middleName: text("middle_name"),
  lastName: text("last_name"),
  suffix: text("suffix"),
  fullName: text("full_name"),
  pronouns: pronounsEnum("pronouns"),
  deceased: boolean("deceased").default(false).notNull(),
  householdName: text("household_name"),
  // Free-text region link; SET NULL so a region delete doesn't cascade to people.
  currentHomeRegionId: text("current_home_region_id").references(
    () => regions.id,
    { onDelete: "set null" },
  ),
  details: text("details"),
  // Team member who owns this person. RESTRICT preserves history when a
  // team member archives.
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  tags: text("tags"),
  lastContacted: date("last_contacted"),
  interactionCount: integer("interaction_count"),
  createdFromCopper: date("created_from_copper"),
  updatedFromCopper: date("updated_from_copper"),
  linkedin: text("linkedin"),
  x: text("x"),
  facebook: text("facebook"),
  instagram: text("instagram"),
  aboutMe: text("about_me"),
  youtube: text("youtube"),
  website: text("website"),
  interestsThematic: text("interests_thematic").array(),
  interestsAges: text("interests_ages").array(),
  interestsGovModels: text("interests_gov_models").array(),
  // Array of regions.id values the person prioritizes. NB: array columns
  // cannot carry native PG FK constraints; integrity is enforced at write
  // time by the API layer.
  regionIds: text("region_ids").array(),
  newsletter: boolean("newsletter").default(false).notNull(),
  unsubscribedToNewsletter: boolean("unsubscribed_to_newsletter")
    .default(false)
    .notNull(),
  childrenAtWf: text("children_at_wf"),
  meetingLink: text("meeting_link"),
  // Self-ref. SET NULL: if the assistant person is deleted, this person
  // just loses the pointer.
  assistantPersonId: text("assistant_person_id").references(
    (): AnyPgColumn => people.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("people_current_home_region_id_idx").on(t.currentHomeRegionId),
  index("people_owner_user_id_idx").on(t.ownerUserId),
  index("people_assistant_person_id_idx").on(t.assistantPersonId),
  index("people_region_ids_gin_idx").using("gin", t.regionIds),
  index("people_interests_thematic_gin_idx").using("gin", t.interestsThematic),
  index("people_interests_ages_gin_idx").using("gin", t.interestsAges),
  index("people_interests_gov_models_gin_idx").using("gin", t.interestsGovModels),
]);

export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
