import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Persisted draft for the reactive "settlement bundle" reconciliation flow.
 *
 * One row per settlement ANCHOR — either a QuickBooks deposit (a
 * `staged_payments` row, `anchorType='qb_staged_payment'`) or a Stripe payout
 * (`stripe_payouts`, `anchorType='stripe_payout'`). A bundle is the COMPLETE
 * proposed end-state for that anchor: the payout↔deposit tie plus, for every
 * Stripe charge / QB line behind it, a per-row {donor (existing|new), gift
 * (match|mint|research|exclude)} proposal with confidence / provenance /
 * warnings.
 *
 * The server is authoritative: the full proposal is always RE-DERIVED from live
 * CRM + processor state on assemble / derive / confirm. This row persists only:
 *
 *   - `overrides`  — the human edits to apply on top of the auto-derivation,
 *     keyed by stable rowKey. These are NEVER clobbered by a sync refresh.
 *   - `derivedProposal` — a cache of the last computed proposal snapshot, so the
 *     workbench can load fast without re-deriving on every GET. Always safe to
 *     recompute; treated as a cache, not the source of truth.
 *   - `sourceFingerprint` — a hash of the underlying source rows (amounts, ids,
 *     statuses) so a sync can detect when the bundle drifted and refresh the
 *     derivation while preserving overrides.
 *   - `revision` — bumped on every derive; the confirm endpoint is idempotent by
 *     (draftId, revision) so a double-submit can't double-book.
 *
 * Confirm commits the whole bundle atomically via the shared money-write
 * primitives (it never forks a parallel money path), then stamps `status` and
 * the confirmer metadata. Drafts are kept after confirm for audit.
 */
export const reconciliationBundleDrafts = pgTable(
  "reconciliation_bundle_drafts",
  {
    // newId()-minted at assemble time.
    id: text("id").primaryKey(),

    // The settlement anchor this bundle reconciles.
    anchorType: text("anchor_type")
      .$type<"qb_staged_payment" | "stripe_payout">()
      .notNull(),
    // staged_payments.id (qb deposit) or stripe_payouts.id (po_...). Kept as
    // plain text (no FK) so the draft survives a hard-deleted/re-pulled anchor
    // and stays out of the merge FK inventory, matching the review-queue
    // convention.
    anchorId: text("anchor_id").notNull(),

    // open: editable draft. confirmed: committed into gifts/ties (terminal).
    // superseded: the anchor changed shape so much the draft was reset.
    status: text("status")
      .$type<"open" | "confirmed" | "superseded">()
      .notNull()
      .default("open"),

    // Bumped on every re-derivation; the confirm guard is keyed on it.
    revision: integer("revision").notNull().default(1),

    // Hash of the underlying source rows; drives the sync drift/refresh guard.
    sourceFingerprint: text("source_fingerprint"),

    // Human edits keyed by stable rowKey (+ a "tie" key for the payout↔deposit
    // tie). Defaults to {}. Survives sync refreshes — never clobbered.
    overrides: jsonb("overrides").notNull().default({}),

    // Cache of the last computed full proposal snapshot (recomputable).
    derivedProposal: jsonb("derived_proposal"),

    // The committed confirm outcome (ReconciliationBundleConfirmResult), stored
    // at confirm time so a double-submit at the same revision can REPLAY the
    // exact prior result (alreadyConfirmed=true) instead of re-committing.
    confirmResult: jsonb("confirm_result"),

    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // One draft per anchor.
    uniqueIndex("reconciliation_bundle_drafts_anchor_unique").on(
      t.anchorType,
      t.anchorId,
    ),
    index("reconciliation_bundle_drafts_status_idx").on(t.status),
  ],
);

export type ReconciliationBundleDraft =
  typeof reconciliationBundleDrafts.$inferSelect;
export type NewReconciliationBundleDraft =
  typeof reconciliationBundleDrafts.$inferInsert;
