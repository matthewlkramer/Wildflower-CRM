import {
  index,
  pgTable,
  text,
  timestamp,
  date,
} from "drizzle-orm/pg-core";
import { taskKindEnum, taskStatusEnum } from "./_enums";
import { users } from "./users";

/**
 * Actionable to-do attached to one or more CRM entities. Same link
 * pattern as `notes` / `interactions` — denormalized `text[]` columns
 * with GIN indexes per linkable entity type.
 *
 * `assigneeUserId` is the single owner. `mentionUserIds` is the set of
 * additional teammates who should see the task in their feed (a
 * watch list, not extra assignees).
 *
 * `dueDate` is a calendar date (no time) because fundraising tasks
 * are managed at the day level. `completedAt` is a timestamp so we
 * can show "completed 3 hours ago" on the activity log.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: date("due_date"),
    // What kind of task this is. `reporting_deadline` rows feed the
    // /reporting-deadlines dashboard; everything else surfaces in the
    // per-entity task panels.
    kind: taskKindEnum("kind").notNull().default("general"),
    status: taskStatusEnum("status").notNull().default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    assigneeUserId: text("assignee_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    personIds: text("person_ids").array(),
    organizationIds: text("organization_ids").array(),
    householdIds: text("household_ids").array(),
    opportunityIds: text("opportunity_ids").array(),
    giftIds: text("gift_ids").array(),
    grantLeadIds: text("grant_lead_ids").array(),
    mentionUserIds: text("mention_user_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("tasks_assignee_user_id_idx").on(t.assigneeUserId),
    index("tasks_created_by_user_id_idx").on(t.createdByUserId),
    index("tasks_status_idx").on(t.status),
    index("tasks_kind_idx").on(t.kind),
    index("tasks_due_date_idx").on(t.dueDate),
    index("tasks_person_ids_gin_idx").using("gin", t.personIds),
    index("tasks_organization_ids_gin_idx").using("gin", t.organizationIds),
    index("tasks_household_ids_gin_idx").using("gin", t.householdIds),
    index("tasks_opportunity_ids_gin_idx").using("gin", t.opportunityIds),
    index("tasks_gift_ids_gin_idx").using("gin", t.giftIds),
    index("tasks_grant_lead_ids_gin_idx").using("gin", t.grantLeadIds),
    index("tasks_mention_user_ids_gin_idx").using("gin", t.mentionUserIds),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
