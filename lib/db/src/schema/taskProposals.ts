import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { people } from "./people";
import { organizations } from "./organizations";
import { tasks } from "./tasks";
import { taskProposalStatusEnum } from "./_enums";

/**
 * AI-suggested next-step cultivation tasks. One row per CRM entity
 * (a person OR an organization) summarises the relationship signals the
 * pipeline saw and the single concrete next step it recommends.
 *
 * Modeled on `email_proposals`: on-demand and cached. The first time a
 * detail page renders the Tasks card we generate a suggestion and store
 * it here; subsequent views read this row so it's instant. A "refresh"
 * regenerates the same pending row in place.
 *
 * Lifecycle: a suggestion is born `pending`. Accepting it spins up a real
 * linked `tasks` row (pointer kept in `accepted_task_id`) and flips the
 * proposal to `accepted`. Dismissing flips it to `dismissed` with an
 * optional reviewer note. We never delete proposals — resolved rows are
 * the audit trail, and they stop claiming the per-entity dedupe slot so a
 * later refresh can surface a fresh `pending` suggestion.
 *
 * `payload` holds the JSON signal bundle the AI reasoned over (recent
 * gifts, open opportunities, last-contact dates, capacity/priority, media
 * mentions) so the rationale stays auditable after the underlying data
 * changes.
 */
export const taskProposals = pgTable(
  "task_proposals",
  {
    id: text("id").primaryKey(),
    status: taskProposalStatusEnum("status").default("pending").notNull(),
    // Exactly one of these is set (enforced by the XOR check below). The
    // proposal is "about" that single entity.
    targetPersonId: text("target_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    targetOrganizationId: text("target_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    // Signal bundle the AI reasoned over (see gatherTaskSignals.ts).
    payload: jsonb("payload").notNull().default({}),
    // AI-drafted suggestion fields. Null until the AI call completes
    // (analyzedAt IS NULL = "generating"). suggestedDueDate is the date
    // the model recommends acting by; copied onto the real task on accept.
    title: text("title"),
    description: text("description"),
    suggestedDueDate: date("suggested_due_date"),
    rationale: text("rationale"),
    // AI bookkeeping — mirrors the email-intelligence pattern. analyzedAt
    // doubles as the in-flight / done signal; error records a failed call
    // without crashing the request.
    analyzedAt: timestamp("analyzed_at"),
    model: text("model"),
    error: text("error"),
    // Dedupe key — per entity, e.g. `person:<id>` / `org:<id>`. The
    // partial unique index keeps at most one PENDING suggestion per
    // entity; resolved rows release the slot.
    dedupeKey: text("dedupe_key").notNull(),
    // Set on accept — points at the real task that was created.
    acceptedTaskId: text("accepted_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    // Optional free-text note captured on dismiss (and stored on accept
    // too if provided) for later prompt tuning.
    reviewerNote: text("reviewer_note"),
    resolvedAt: timestamp("resolved_at"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // At most one pending suggestion per entity; resolved rows don't claim
    // the slot, so a refresh after accept/dismiss can surface a new one.
    uniqueIndex("task_proposals_dedupe_pending_uq")
      .on(t.dedupeKey)
      .where(sql`status = 'pending'`),
    index("task_proposals_target_person_idx").on(t.targetPersonId),
    index("task_proposals_target_organization_idx").on(t.targetOrganizationId),
    // Exactly one target entity per proposal.
    check(
      "task_proposals_target_xor",
      sql`num_nonnulls(${t.targetPersonId}, ${t.targetOrganizationId}) = 1`,
    ),
  ],
);

export type TaskProposal = typeof taskProposals.$inferSelect;
export type NewTaskProposal = typeof taskProposals.$inferInsert;
