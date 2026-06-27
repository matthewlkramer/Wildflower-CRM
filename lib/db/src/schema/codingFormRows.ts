import {
  pgTable,
  text,
  integer,
  numeric,
  date,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { codingFormRowStatusEnum, intendedUsageEnum } from "./_enums";

/**
 * One-time import + reconciliation staging for the Wildflower "Donation Revenue
 * Coding Form" exports (FY24, FY25, FY26 Google Form responses) plus the
 * Girasol / Act-60 donations sheet.
 *
 * Each row is ONE parsed gift line from a source spreadsheet. The table is the
 * durable home for the import-review workflow:
 *
 *   1. RAW captured values — every column lifted verbatim from the sheet,
 *      read-only after the importer writes them (the re-runnable seed only ever
 *      refreshes raw/normalized fields; it never clobbers reviewer decisions or
 *      `status`). `rawData` keeps the entire normalized record as JSON for
 *      provenance / "needs a decision" attributes that have no schema home.
 *
 *   2. NORMALIZED scalars — parsed amount/date/address/report-deadline pulled
 *      out for matching, display and cross-check.
 *
 *   3. PROPOSED match — the donor (organization / person / household, kept as
 *      plain text ids following the review-queue convention so this staging
 *      state stays out of the live merge FK-inventory; Donor XOR is enforced in
 *      the API at match-confirm / apply time, not by a DB CHECK, because a row
 *      may legitimately have ZERO matches) plus the matched opportunity / gift.
 *      `matchConfirmedAt` records that a human accepted (or overrode) the guess.
 *
 *   4. REVIEWER decisions — `decisions` jsonb maps each cross-checked attribute
 *      (reportDeadline / restriction / intendedUsage / purpose / address) to the
 *      reviewer's choice (apply / skip). The cross-check itself (new / same /
 *      conflict) is computed LIVE on read against current CRM state so it never
 *      goes stale — only the decision is persisted here.
 *
 *   5. APPLIED state — `status` + `appliedAt` + the ids of the artifacts the
 *      apply step created (`appliedTaskId`, `appliedAddressId`,
 *      `appliedAllocationId`) so re-applying is idempotent.
 *
 * Grant-agreement PDF ingestion (Task #485): the captured `driveLink` is
 * resolved through the Google Drive connector, the PDF is uploaded to object
 * storage and attached to the matched opportunity/pledge via the normal
 * grant-letter flow. The `grantLetterImported*` columns record what we attached
 * (and the matched opp's url) so re-runs are idempotent and a fetch failure is
 * surfaced per-row instead of silently lost. Grant letters live on opportunities
 * /pledges, never on gifts.
 */
export const codingFormRows = pgTable(
  "coding_form_rows",
  {
    // Deterministic id `cfr_<source>_<rowIndex>` so re-importing is idempotent.
    id: text("id").primaryKey(),
    // Which sheet this row came from: 'fy24' | 'fy25' | 'fy26' | 'girasol'.
    source: text("source").notNull(),
    // 0-based data-row index within that sheet (after header/junk rows).
    sourceRowIndex: integer("source_row_index").notNull(),

    // ── 1. Raw captured values (read-only provenance) ──────────────────────
    // The complete normalized record as parsed from the sheet, including the
    // "needs a decision" attributes that have no schema home (donor type,
    // stand-alone vs multi-series, circle/coding, additional notes, Stripe fee,
    // Class, deposit date, etc.).
    rawData: jsonb("raw_data").notNull(),
    donorNameRaw: text("donor_name_raw"),
    internalMemo: text("internal_memo"),
    donorTypeRaw: text("donor_type_raw"),
    seriesTypeRaw: text("series_type_raw"),
    restrictionLanguage: text("restriction_language"),
    donorNameAddressRaw: text("donor_name_address_raw"),
    reportRequiredRaw: text("report_required_raw"),
    // Grant-agreement Google Drive link — captured for the downstream PDF task.
    driveLink: text("drive_link"),
    circleRaw: text("circle_raw"),
    additionalNotes: text("additional_notes"),
    paymentMethodRaw: text("payment_method_raw"),
    stripeFeesRaw: text("stripe_fees_raw"),
    classRaw: text("class_raw"),
    submitterEmail: text("submitter_email"),
    wildflowerPartner: text("wildflower_partner"),

    // ── 2. Normalized scalars ──────────────────────────────────────────────
    amount: numeric("amount", { precision: 14, scale: 2 }),
    donationDate: date("donation_date"),
    depositDate: date("deposit_date"),
    // Best-effort parse of the donor mailing address (from the audit field).
    addrStreet: text("addr_street"),
    addrCity: text("addr_city"),
    addrState: text("addr_state"),
    addrPostal: text("addr_postal"),
    addrCountry: text("addr_country"),
    // Parsed from the "does this require a written report?" free text.
    reportRequired: boolean("report_required"),
    reportDueDate: date("report_due_date"),
    // Conservative intended-usage suggestion derived from memo/restriction text;
    // null when no confident mapping exists (flagged for a decision instead).
    intendedUsageSuggested: intendedUsageEnum("intended_usage_suggested"),

    // ── 3. Proposed / confirmed match (plain text, app-layer Donor XOR) ─────
    organizationId: text("organization_id"),
    individualGiverPersonId: text("individual_giver_person_id"),
    householdId: text("household_id"),
    matchedOpportunityId: text("matched_opportunity_id"),
    matchedGiftId: text("matched_gift_id"),
    matchScore: integer("match_score"),
    matchMethod: text("match_method"),
    // 'high' | 'suggested' | 'none' — the matcher's confidence tier.
    matchTier: text("match_tier"),
    matchConfirmedAt: timestamp("match_confirmed_at"),
    matchConfirmedByUserId: text("match_confirmed_by_user_id"),

    // ── 4. Reviewer decisions ──────────────────────────────────────────────
    // { [attribute]: 'apply' | 'skip' } — defaults to {}. The live cross-check
    // (new/same/conflict) is computed on read and NOT stored here.
    decisions: jsonb("decisions").notNull().default({}),

    // ── 5. Applied state (idempotency) ─────────────────────────────────────
    status: codingFormRowStatusEnum("status").notNull().default("pending"),
    appliedAt: timestamp("applied_at"),
    appliedByUserId: text("applied_by_user_id"),
    appliedTaskId: text("applied_task_id"),
    appliedAddressId: text("applied_address_id"),
    appliedAllocationId: text("applied_allocation_id"),

    // ── 6. Grant-agreement PDF import state (idempotency) ───────────────────
    // The object-storage url + filename we attached to the matched opportunity
    // from the Drive link, the timestamp, and the last fetch/upload error. A
    // re-run is a no-op when the matched opp's grant_letter_url still equals
    // `grantLetterImportedUrl`; a fetch failure is recorded here so the reviewer
    // can see which links failed without re-fetching.
    grantLetterImportedUrl: text("grant_letter_imported_url"),
    grantLetterImportedFilename: text("grant_letter_imported_filename"),
    grantLetterImportedAt: timestamp("grant_letter_imported_at"),
    grantLetterImportError: text("grant_letter_import_error"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("coding_form_rows_source_row_unique").on(
      t.source,
      t.sourceRowIndex,
    ),
    index("coding_form_rows_status_idx").on(t.status),
    index("coding_form_rows_source_idx").on(t.source),
    index("coding_form_rows_organization_id_idx").on(t.organizationId),
    index("coding_form_rows_person_id_idx").on(t.individualGiverPersonId),
    index("coding_form_rows_household_id_idx").on(t.householdId),
  ],
);

export type CodingFormRow = typeof codingFormRows.$inferSelect;
export type NewCodingFormRow = typeof codingFormRows.$inferInsert;
