import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { grantLeads } from "./grantLeads";
import { households } from "./households";
import { mediaMentions } from "./mediaMentions";
import { meetingNotes } from "./meetingNotes";
import { organizations } from "./organizations";
import { people } from "./people";
import { tasks } from "./tasks";
import { users } from "./users";

export const findingKinds = ["media", "grant_lead"] as const;
export const findingCategories = [
  "funding_opportunity",
  "strategy_priorities",
  "leadership_staff",
  "general_news",
] as const;
export const agendaStatuses = [
  "pending",
  "discussing",
  "done",
  "deferred",
] as const;
export const scanStatuses = [
  "pending",
  "updates",
  "no_updates",
  "failed",
  "partial",
] as const;

export const developmentAgenda = pgTable(
  "development_agenda",
  {
    id: text("id").primaryKey(),
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetingNotes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    decision: text("decision").notNull().default(""),
    status: text("status", { enum: agendaStatuses })
      .notNull()
      .default("pending"),
    revision: integer("revision").notNull().default(0),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    personId: text("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    householdId: text("household_id").references(() => households.id, {
      onDelete: "set null",
    }),
    findingKind: text("finding_kind", { enum: findingKinds }),
    findingId: text("finding_id"),
    carriedFromId: text("carried_from_id").references(
      (): AnyPgColumn => developmentAgenda.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    index("development_agenda_meeting_idx").on(t.meetingId, t.position),
    index("development_agenda_organization_idx").on(
      t.organizationId,
      t.meetingId,
    ),
    uniqueIndex("development_agenda_finding_uq")
      .on(t.meetingId, t.findingKind, t.findingId)
      .where(sql`${t.findingId} IS NOT NULL`),
    check(
      "development_agenda_status_check",
      sql`${t.status} IN ('pending','discussing','done','deferred')`,
    ),
  ],
);

export const developmentAgendaTasks = pgTable(
  "development_agenda_tasks",
  {
    agendaItemId: text("agenda_item_id")
      .notNull()
      .references(() => developmentAgenda.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agendaItemId, t.requestId] })],
);

export const funderScanState = pgTable(
  "funder_scan_state",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    status: text("status", { enum: scanStatuses }).notNull(),
    findingCount: integer("finding_count").notNull().default(0),
  },
  (t) => [
    check(
      "funder_scan_state_status_check",
      sql`${t.status} IN ('pending','updates','no_updates','failed','partial')`,
    ),
  ],
);

export const funderFindings = pgTable(
  "funder_findings",
  {
    mediaMentionId: text("media_mention_id")
      .primaryKey()
      .references(() => mediaMentions.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantLeadId: text("grant_lead_id").references(() => grantLeads.id, {
      onDelete: "set null",
    }),
    category: text("category", { enum: findingCategories }).notNull(),
    summary: text("summary"),
    deadline: date("deadline"),
    officialSource: boolean("official_source").notNull().default(false),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("funder_findings_discovered_at_idx").on(t.discoveredAt),
    index("funder_findings_grant_lead_idx").on(t.grantLeadId),
    check(
      "funder_findings_category_check",
      sql`${t.category} IN ('funding_opportunity','strategy_priorities','leadership_staff','general_news')`,
    ),
  ],
);

export const fundraisingFindingReviews = pgTable(
  "fundraising_finding_reviews",
  {
    kind: text("kind", { enum: findingKinds }).notNull(),
    findingId: text("finding_id").notNull(),
    review: text("review", { enum: ["useful", "dismissed"] }).notNull(),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.findingId] }),
    check(
      "fundraising_finding_reviews_kind_check",
      sql`${t.kind} IN ('media','grant_lead')`,
    ),
    check(
      "fundraising_finding_reviews_review_check",
      sql`${t.review} IN ('useful','dismissed')`,
    ),
  ],
);
