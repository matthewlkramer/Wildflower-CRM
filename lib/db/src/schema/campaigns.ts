import {
  pgTable,
  text,
  timestamp,
  numeric,
  date,
  boolean,
} from "drizzle-orm/pg-core";
import { fundEnum } from "./users";

export const campaigns = pgTable("campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  fund: fundEnum("fund"),
  fiscalYear: text("fiscal_year"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  goalAmount: numeric("goal_amount", { precision: 15, scale: 2 }),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
