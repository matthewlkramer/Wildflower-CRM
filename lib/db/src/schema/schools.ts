import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { schoolStatusEnum, governanceModelEnum } from "./_enums";

export const schools = pgTable("schools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  longName: text("long_name"),
  shortName: text("short_name"),
  status: schoolStatusEnum("status"),
  governanceModel: governanceModelEnum("governance_model"),
  agesPlanes: text("ages_planes").array(),
  logoMainSquareUrl: text("logo_main_square_url"),
  stageStatus: text("stage_status"),
  currentMailingAddress: text("current_mailing_address"),
  currentPhysicalAddress: text("current_physical_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("schools_ages_planes_gin_idx").using("gin", t.agesPlanes),
]);

export type School = typeof schools.$inferSelect;
export type NewSchool = typeof schools.$inferInsert;
