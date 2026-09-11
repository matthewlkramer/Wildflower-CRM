import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { people } from "./people";
import { users } from "./users";

/**
 * CRM-owned travel intent. Calendar and email evidence remain owned by their
 * sync tables; the trip API derives schedule, availability, invitation, and
 * response facts at read time.
 */
export const tripPlans = pgTable(
  "trip_plans",
  {
    id: text("id").primaryKey(),
    travelerUserId: text("traveler_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title"),
    destinationCity: text("destination_city"),
    destinationState: text("destination_state"),
    travelStartsAt: timestamp("travel_starts_at", {
      withTimezone: true,
    }).notNull(),
    travelEndsAt: timestamp("travel_ends_at", { withTimezone: true }).notNull(),
    meetingWindowStartsAt: timestamp("meeting_window_starts_at", {
      withTimezone: true,
    }),
    meetingWindowEndsAt: timestamp("meeting_window_ends_at", {
      withTimezone: true,
    }),
    outboundTravelMinutes: integer("outbound_travel_minutes"),
    returnTravelMinutes: integer("return_travel_minutes"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("trip_plans_traveler_start_idx").on(
      t.travelerUserId,
      t.travelStartsAt,
    ),
    index("trip_plans_archived_at_idx").on(t.archivedAt),
    check(
      "trip_plans_positive_window",
      sql`${t.travelEndsAt} > ${t.travelStartsAt}`,
    ),
    check(
      "trip_plans_meeting_window_pair",
      sql`(${t.meetingWindowStartsAt} is null) = (${t.meetingWindowEndsAt} is null)`,
    ),
    check(
      "trip_plans_meeting_window_inside_trip",
      sql`${t.meetingWindowStartsAt} is null or (${t.meetingWindowStartsAt} >= ${t.travelStartsAt} and ${t.meetingWindowEndsAt} <= ${t.travelEndsAt} and ${t.meetingWindowEndsAt} > ${t.meetingWindowStartsAt})`,
    ),
    check(
      "trip_plans_outbound_minutes_nonnegative",
      sql`${t.outboundTravelMinutes} is null or ${t.outboundTravelMinutes} >= 0`,
    ),
    check(
      "trip_plans_return_minutes_nonnegative",
      sql`${t.returnTravelMinutes} is null or ${t.returnTravelMinutes} >= 0`,
    ),
  ],
);

/** Editable priority list for a trip. Removing someone archives the row. */
export const tripVisitCandidates = pgTable(
  "trip_visit_candidates",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => tripPlans.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    rank: integer("rank").notNull(),
    rationale: text("rationale"),
    source: text("source").notNull(),
    notes: text("notes"),
    nextStep: text("next_step"),
    planningUpdatedByUserId: text("planning_updated_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    planningUpdatedAt: timestamp("planning_updated_at", {
      withTimezone: true,
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("trip_visit_candidates_trip_person_uq").on(
      t.tripId,
      t.personId,
    ),
    index("trip_visit_candidates_trip_rank_idx").on(t.tripId, t.rank),
    index("trip_visit_candidates_person_idx").on(t.personId),
    check("trip_visit_candidates_rank_positive", sql`${t.rank} >= 1`),
    check(
      "trip_visit_candidates_source_check",
      sql`${t.source} in ('system_draft', 'manual')`,
    ),
  ],
);

/** Append-only team discussion for a trip. */
export const tripPlanComments = pgTable(
  "trip_plan_comments",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => tripPlans.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("trip_plan_comments_trip_created_idx").on(t.tripId, t.createdAt),
    check(
      "trip_plan_comments_body_nonblank",
      sql`length(trim(${t.body})) > 0`,
    ),
  ],
);

export type TripPlan = typeof tripPlans.$inferSelect;
export type NewTripPlan = typeof tripPlans.$inferInsert;
export type TripVisitCandidate = typeof tripVisitCandidates.$inferSelect;
export type NewTripVisitCandidate = typeof tripVisitCandidates.$inferInsert;
export type TripPlanComment = typeof tripPlanComments.$inferSelect;
export type NewTripPlanComment = typeof tripPlanComments.$inferInsert;
