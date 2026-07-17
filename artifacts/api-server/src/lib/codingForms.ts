import { db } from "@workspace/db";
import {
  codingFormRows,
  giftAllocations,
  pledgeAllocations,
  opportunitiesAndPledges,
  giftsAndPayments,
  organizations,
  people,
  households,
  addresses,
  tasks,
} from "@workspace/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  scoreStagedPayment,
  type MatchMethod,
  type MatchTier,
} from "./quickbooksMatch";
import { giftMatchAmountBounds, GIFT_MATCH_WINDOW_DAYS } from "./giftMatch";
import { newId } from "./helpers";

/**
 * Matching, live cross-check and idempotent apply for the one-time donation
 * coding-form import (Task #484). The cross-check is computed LIVE on read
 * against current CRM state (never persisted) so it can never go stale; only the
 * reviewer's per-attribute decision and the apply artifacts are persisted on the
 * `coding_form_rows` staging table.
 *
 * Guiding rule (from the user): **compare, don't clobber** — fill only what is
 * genuinely missing, surface conflicts for a human choice, and list any
 * attribute with no schema home in a "needs a decision" summary instead of
 * forcing it in.
 */

export type CodingFormRowSelect = typeof codingFormRows.$inferSelect;

// ── Cross-check model ────────────────────────────────────────────────────────

export type CrossCheckStatus = "new" | "same" | "conflict" | "na";

export type CodingFormAttribute =
  | "reportDeadline"
  | "purposeVerbatim"
  | "usageRestriction"
  | "intendedUsage"
  | "address"
  // Raw coding-form reference values stamped on the matched gift "for looking
  // at later" (no structured home). See crossChecksFor / applyRow.
  | "circle"
  | "seriesType"
  | "additionalNotes"
  | "internalMemo";

export interface CrossCheck {
  attribute: CodingFormAttribute;
  label: string;
  status: CrossCheckStatus;
  applicable: boolean;
  sheetValue: string | null;
  crmValue: string | null;
  targetType: string | null;
  targetId: string | null;
  decision: "apply" | "skip" | null;
  blockedReason: string | null;
}

export interface NeedsDecisionItem {
  attribute: string;
  label: string;
  value: string | null;
}

/**
 * Spreadsheet attributes with no existing schema home (per row).
 *
 * All eight original coding-form "needs a decision" attributes have now been
 * resolved, so this list is intentionally empty:
 *   - donorType / stripeFees / class (QuickBooks Class) / depositDate → DROPPED:
 *     already captured or derived elsewhere in the CRM (donor type remains a
 *     matching hint only; fees / class / deposit date come from the QuickBooks +
 *     Stripe reconciliation pipeline). The raw values are still retained on
 *     coding_form_rows for provenance — they're just no longer flagged.
 *   - circle / seriesType / additionalNotes / internalMemo → RE-HOMED as raw,
 *     read-only reference copies on the MATCHED GIFT, applied through the normal
 *     compare-don't-clobber cross-check pipeline (see crossChecksFor / applyRow).
 *
 * The mechanism is retained for any genuinely homeless future attribute.
 */
const NEEDS_DECISION_FIELDS: Array<{
  attribute: string;
  label: string;
  get: (r: CodingFormRowSelect) => string | null;
}> = [];

export const NEEDS_DECISION_ATTRIBUTES = NEEDS_DECISION_FIELDS.map(
  (f) => f.attribute,
);

/**
 * Per-attribute "has a value" predicates for the summary counts — how many rows
 * carry a value for each no-schema-home attribute.
 */
export const NEEDS_DECISION_FIELDS_META: Array<{
  attribute: string;
  nonEmpty: SQL;
}> = [];

export function needsDecisionFor(row: CodingFormRowSelect): NeedsDecisionItem[] {
  const out: NeedsDecisionItem[] = [];
  for (const f of NEEDS_DECISION_FIELDS) {
    const value = f.get(row);
    if (value != null && String(value).trim().length > 0) {
      out.push({ attribute: f.attribute, label: f.label, value });
    }
  }
  return out;
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface OppHit {
  id: string;
  name: string | null;
}

function donorWhereOpp(row: CodingFormRowSelect) {
  if (row.organizationId)
    return eq(opportunitiesAndPledges.organizationId, row.organizationId);
  if (row.individualGiverPersonId)
    return eq(
      opportunitiesAndPledges.individualGiverPersonId,
      row.individualGiverPersonId,
    );
  if (row.householdId)
    return eq(opportunitiesAndPledges.householdId, row.householdId);
  return null;
}

/**
 * The single most-likely opportunity/pledge for a resolved donor, by amount/date
 * proximity. Returns null when the donor has zero or many candidate opportunities
 * (ambiguous — a human picks). Never auto-applies a fuzzy guess.
 */
async function bestOpportunityFor(
  row: CodingFormRowSelect,
): Promise<string | null> {
  const where = donorWhereOpp(row);
  if (!where) return null;
  const rows = await db
    .select({ id: opportunitiesAndPledges.id })
    .from(opportunitiesAndPledges)
    .where(and(where, sql`${opportunitiesAndPledges.archivedAt} IS NULL`))
    .orderBy(
      row.amount
        ? sql`ABS(COALESCE(${opportunitiesAndPledges.awardedAmount}, ${opportunitiesAndPledges.askAmount}, 0) - ${row.amount}::numeric) ASC NULLS LAST`
        : sql`${opportunitiesAndPledges.createdAt} DESC`,
    )
    .limit(2);
  // Only auto-fill when there is exactly ONE candidate. Zero (nothing to match)
  // and many (ambiguous — a human must pick) both return null so the row is
  // surfaced as unresolved rather than steered against a guessed opportunity.
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * The proposed match for a row: the donor (via the shared scored matcher), the
 * single unambiguous gift the matcher resolved, and a same-donor opportunity.
 * Donor XOR holds because scoreStagedPayment returns at most one donor FK.
 */
export interface ProposedMatch {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  matchedGiftId: string | null;
  matchedOpportunityId: string | null;
  matchScore: number;
  matchMethod: MatchMethod | null;
  matchTier: MatchTier;
}

/**
 * Compute (READ-ONLY — no write) a fresh proposed match for a row: donor via the
 * shared scored matcher, then a same-donor opportunity. Extracted so the exact
 * live match can be reused by read-only tooling (the one-time conflict-analysis
 * script) without persisting or clearing anything. `rematchRow` layers the write
 * (+ confirmation reset) on top of this.
 */
export async function computeProposedMatch(
  row: CodingFormRowSelect,
): Promise<ProposedMatch> {
  const scored = await scoreStagedPayment({
    payerName: row.donorNameRaw,
    payerEmail: null,
    rawReference: row.internalMemo,
    lineDescription: row.restrictionLanguage,
    amount: row.amount ? String(row.amount) : null,
    dateReceived: row.donationDate ? String(row.donationDate) : null,
  });

  const donor = {
    organizationId: scored.donor.organizationId,
    individualGiverPersonId: scored.donor.individualGiverPersonId,
    householdId: scored.donor.householdId,
  };
  const withDonor = {
    ...row,
    ...donor,
    matchedGiftId: scored.matchedGiftId,
  } as CodingFormRowSelect;
  const matchedOpportunityId = await bestOpportunityFor(withDonor);

  // Coding-form gift pass: the scored matcher's strict ingest window misses
  // most sheet rows (the gift was often booked weeks away). When it found no
  // gift but the donor DID resolve, look for the single unambiguous same-donor
  // EXACT-amount gift within ±GIFT_MATCH_WINDOW_DAYS of the donation date.
  // Exactly one → propose it; zero or many → stay null (ambiguous rows surface
  // their live candidate list in serializeRow so a human picks — never guess).
  let matchedGiftId = scored.matchedGiftId;
  if (matchedGiftId == null) {
    const candidates = await giftCandidatesFor(withDonor, 2);
    if (candidates.length === 1) matchedGiftId = candidates[0].id;
  }

  return {
    ...donor,
    matchedGiftId,
    matchedOpportunityId,
    matchScore: scored.score,
    matchMethod: scored.method,
    matchTier: scored.tier,
  };
}

/**
 * Compute and persist a fresh proposed match for a row. Clears any prior human
 * confirmation.
 */
export async function rematchRow(
  row: CodingFormRowSelect,
): Promise<CodingFormRowSelect> {
  const m = await computeProposedMatch(row);

  const [updated] = await db
    .update(codingFormRows)
    .set({
      organizationId: m.organizationId,
      individualGiverPersonId: m.individualGiverPersonId,
      householdId: m.householdId,
      matchedGiftId: m.matchedGiftId,
      matchedOpportunityId: m.matchedOpportunityId,
      matchScore: m.matchScore,
      matchMethod: m.matchMethod,
      matchTier: m.matchTier,
      matchConfirmedAt: null,
      matchConfirmedByUserId: null,
      updatedAt: new Date(),
    })
    .where(eq(codingFormRows.id, row.id))
    .returning();
  return updated;
}

/** Shape of one live gift candidate returned on unresolved rows. */
export interface GiftCandidate {
  id: string;
  name: string | null;
  amount: string | null;
  dateReceived: string | null;
}

/**
 * LIVE (never persisted) same-donor gift candidates for a coding-form row: the
 * row's resolved donor's non-archived gifts at the EXACT sheet amount within
 * ±GIFT_MATCH_WINDOW_DAYS of the donation date. The sheet transcribes the
 * booked gift amount itself (no processor-fee gap), so the band is the "exact"
 * mode of the ONE shared matcher predicate (giftMatchAmountBounds) — never a
 * sibling copy. Requires donor + amount + donation date; otherwise there is
 * nothing safe to anchor on and the list is empty. Closest date first.
 */
export async function giftCandidatesFor(
  row: CodingFormRowSelect,
  limit = 6,
): Promise<GiftCandidate[]> {
  const donorWhere = row.organizationId
    ? eq(giftsAndPayments.organizationId, row.organizationId)
    : row.individualGiverPersonId
      ? eq(giftsAndPayments.individualGiverPersonId, row.individualGiverPersonId)
      : row.householdId
        ? eq(giftsAndPayments.householdId, row.householdId)
        : null;
  if (!donorWhere || row.amount == null || !row.donationDate) return [];
  // Values come from the row's own DB columns (numeric / date), so the casts
  // below re-apply their native types — not user input needing validation.
  const anchorAmount = sql`${String(row.amount)}::numeric`;
  const anchorDate = sql`${String(row.donationDate)}::date`;
  const rows = await db
    .select({
      id: giftsAndPayments.id,
      name: giftsAndPayments.name,
      amount: giftsAndPayments.amount,
      dateReceived: giftsAndPayments.dateReceived,
    })
    .from(giftsAndPayments)
    .where(
      and(
        donorWhere,
        sql`${giftsAndPayments.archivedAt} IS NULL`,
        sql`${giftsAndPayments.dateReceived} IS NOT NULL`,
        giftMatchAmountBounds(
          sql`${giftsAndPayments.amount}`,
          anchorAmount,
          "exact",
        ),
        sql`ABS(${giftsAndPayments.dateReceived} - ${anchorDate}) <= ${GIFT_MATCH_WINDOW_DAYS}`,
      ),
    )
    .orderBy(
      sql`ABS(${giftsAndPayments.dateReceived} - ${anchorDate}) ASC`,
      sql`${giftsAndPayments.id} ASC`,
    )
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    amount: r.amount != null ? String(r.amount) : null,
    dateReceived: r.dateReceived ? String(r.dateReceived) : null,
  }));
}

/**
 * Bulk re-run the matcher over every row still awaiting review.
 * GUARD (do not weaken): only rows with status='pending' AND
 * matchConfirmedAt IS NULL pass through — rematchRow rewrites the donor FKs
 * and CLEARS confirmations, so a confirmed, applied, or skipped row must never
 * reach it.
 */
export async function rematchPendingRows(): Promise<{
  scanned: number;
  updated: number;
  giftMatches: number;
}> {
  const rows = await db
    .select()
    .from(codingFormRows)
    .where(
      and(
        eq(codingFormRows.status, "pending"),
        sql`${codingFormRows.matchConfirmedAt} IS NULL`,
      ),
    );
  let updated = 0;
  let giftMatches = 0;
  // Small chunks: each rematch runs several matcher queries; 5-wide keeps the
  // bulk pass snappy without saturating the pool.
  const CHUNK = 5;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map((r) => rematchRow(r)));
    for (let j = 0; j < results.length; j++) {
      const before = chunk[j];
      const after = results[j];
      if (
        before.organizationId !== after.organizationId ||
        before.individualGiverPersonId !== after.individualGiverPersonId ||
        before.householdId !== after.householdId ||
        before.matchedGiftId !== after.matchedGiftId ||
        before.matchedOpportunityId !== after.matchedOpportunityId
      ) {
        updated++;
      }
      if (after.matchedGiftId != null) giftMatches++;
    }
  }
  return { scanned: rows.length, updated, giftMatches };
}

// ── Allocation resolution ────────────────────────────────────────────────────

interface AllocationRef {
  kind: "gift" | "pledge";
  id: string;
  purposeVerbatim: string | null;
  usageRestrictionType: string;
  intendedUsage: string | null;
}

/**
 * The single allocation the restriction / intended-usage attributes target —
 * the matched gift's allocation when a gift matched, else the matched
 * opportunity's pledge allocation. Returns the row + a reason when there is no
 * single unambiguous allocation.
 */
async function resolveAllocation(
  row: CodingFormRowSelect,
): Promise<{ alloc: AllocationRef | null; blockedReason: string | null }> {
  if (row.matchedGiftId) {
    const rows = await db
      .select({
        id: giftAllocations.id,
        purposeVerbatim: giftAllocations.purposeVerbatim,
        usageRestrictionType: giftAllocations.usageRestrictionType,
        intendedUsage: giftAllocations.intendedUsage,
      })
      .from(giftAllocations)
      .where(eq(giftAllocations.giftId, row.matchedGiftId))
      .limit(2);
    if (rows.length === 0)
      return { alloc: null, blockedReason: "matched gift has no allocation" };
    if (rows.length > 1)
      return {
        alloc: null,
        blockedReason: "matched gift has multiple allocations",
      };
    return { alloc: { kind: "gift", ...rows[0] }, blockedReason: null };
  }
  if (row.matchedOpportunityId) {
    const rows = await db
      .select({
        id: pledgeAllocations.id,
        purposeVerbatim: pledgeAllocations.purposeVerbatim,
        usageRestrictionType: pledgeAllocations.usageRestrictionType,
        intendedUsage: pledgeAllocations.intendedUsage,
      })
      .from(pledgeAllocations)
      .where(eq(pledgeAllocations.pledgeOrOpportunityId, row.matchedOpportunityId))
      .limit(2);
    if (rows.length === 0)
      return {
        alloc: null,
        blockedReason: "matched opportunity has no allocation",
      };
    if (rows.length > 1)
      return {
        alloc: null,
        blockedReason: "matched opportunity has multiple allocations",
      };
    return { alloc: { kind: "pledge", ...rows[0] }, blockedReason: null };
  }
  return { alloc: null, blockedReason: "no matched opportunity or gift" };
}

// ── Donor / opportunity display + address lookup ─────────────────────────────

async function donorName(row: CodingFormRowSelect): Promise<string | null> {
  if (row.organizationId) {
    const r = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, row.organizationId))
      .then((x) => x[0]);
    return r?.name ?? null;
  }
  if (row.individualGiverPersonId) {
    const r = await db
      .select({ name: people.fullName })
      .from(people)
      .where(eq(people.id, row.individualGiverPersonId))
      .then((x) => x[0]);
    return r?.name ?? null;
  }
  if (row.householdId) {
    const r = await db
      .select({ name: households.name })
      .from(households)
      .where(eq(households.id, row.householdId))
      .then((x) => x[0]);
    return r?.name ?? null;
  }
  return null;
}

async function opportunityName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const r = await db
    .select({ name: opportunitiesAndPledges.name })
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, id))
    .then((x) => x[0]);
  return r?.name ?? null;
}

async function matchedGiftName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const r = await db
    .select({ name: giftsAndPayments.name })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, id))
    .then((x) => x[0]);
  return r?.name ?? null;
}

function addressOwnerWhere(row: CodingFormRowSelect) {
  if (row.organizationId)
    return eq(addresses.organizationId, row.organizationId);
  if (row.individualGiverPersonId)
    return eq(addresses.personId, row.individualGiverPersonId);
  if (row.householdId) return eq(addresses.householdId, row.householdId);
  return null;
}

function hasDonor(row: CodingFormRowSelect): boolean {
  return !!(
    row.organizationId ||
    row.individualGiverPersonId ||
    row.householdId
  );
}

/** An equivalent reporting-deadline task already on the opportunity (same due date). */
async function existingReportingTask(
  oppId: string,
  dueDate: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, "reporting_deadline"),
        eq(tasks.dueDate, dueDate),
        sql`${tasks.opportunityIds} @> ARRAY[${oppId}]::text[]`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

async function existingAddressId(
  row: CodingFormRowSelect,
): Promise<string | null> {
  const where = addressOwnerWhere(row);
  if (!where) return null;
  const rows = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(where)
    .limit(1);
  return rows[0]?.id ?? null;
}

const INTENDED_USAGE_LABELS: Record<string, string> = {
  gen_ops: "Gen Ops",
  growth: "Growth",
  school_startup: "School Startup",
  teacher_training: "Teacher Training",
  project: "Project",
};

// ── Cross-check computation ──────────────────────────────────────────────────

function eqText(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export async function crossChecksFor(
  row: CodingFormRowSelect,
): Promise<CrossCheck[]> {
  const decisions = (row.decisions ?? {}) as Record<string, "apply" | "skip">;
  const dec = (a: CodingFormAttribute): "apply" | "skip" | null =>
    decisions[a] ?? null;

  const out: CrossCheck[] = [];

  // 1. Reporting deadline → reporting_deadline task on the matched opportunity.
  {
    const applicable = !!(row.reportRequired && row.reportDueDate);
    let status: CrossCheckStatus = "na";
    let crmValue: string | null = null;
    let targetId: string | null = null;
    let blockedReason: string | null = null;
    if (applicable) {
      if (!row.matchedOpportunityId) {
        blockedReason = "no matched opportunity to attach the deadline to";
        status = "na";
      } else {
        const existing = await existingReportingTask(
          row.matchedOpportunityId,
          String(row.reportDueDate),
        );
        if (existing) {
          status = "same";
          crmValue = String(row.reportDueDate);
          targetId = existing;
        } else {
          status = "new";
        }
      }
    }
    out.push({
      attribute: "reportDeadline",
      label: "Reporting deadline",
      status,
      applicable,
      sheetValue: row.reportDueDate ? String(row.reportDueDate) : null,
      crmValue,
      targetType: "task",
      targetId,
      decision: dec("reportDeadline"),
      blockedReason,
    });
  }

  // Allocation-targeted attributes share one resolution.
  const restrictionPresent = !!(
    row.restrictionLanguage && row.restrictionLanguage.trim().length > 0
  );
  const intendedPresent = !!row.intendedUsageSuggested;
  const needAlloc = restrictionPresent || intendedPresent;
  const { alloc, blockedReason: allocBlocked } = needAlloc
    ? await resolveAllocation(row)
    : { alloc: null, blockedReason: null };

  // 2. Purpose (verbatim restriction language) → allocation.purposeVerbatim.
  {
    const applicable = restrictionPresent;
    let status: CrossCheckStatus = "na";
    let crmValue: string | null = null;
    let blockedReason: string | null = null;
    if (applicable) {
      if (!alloc) {
        blockedReason = allocBlocked;
        status = "na";
      } else {
        crmValue = alloc.purposeVerbatim;
        if (!crmValue || crmValue.trim().length === 0) status = "new";
        else if (eqText(crmValue, row.restrictionLanguage)) status = "same";
        else status = "conflict";
      }
    }
    out.push({
      attribute: "purposeVerbatim",
      label: "Restriction language (purpose)",
      status,
      applicable,
      sheetValue: row.restrictionLanguage,
      crmValue,
      targetType: "allocation",
      targetId: alloc?.id ?? null,
      decision: dec("purposeVerbatim"),
      blockedReason,
    });
  }

  // 3. Usage restriction axis → allocation.usageRestrictionType=donor_restricted.
  {
    const applicable = restrictionPresent;
    let status: CrossCheckStatus = "na";
    let crmValue: string | null = null;
    let blockedReason: string | null = null;
    if (applicable) {
      if (!alloc) {
        blockedReason = allocBlocked;
        status = "na";
      } else {
        crmValue = alloc.usageRestrictionType;
        if (crmValue === "donor_restricted") status = "same";
        else if (crmValue === "unrestricted") status = "new";
        else status = "conflict"; // wf_restricted differs from donor intent
      }
    }
    out.push({
      attribute: "usageRestriction",
      label: "Usage restriction",
      status,
      applicable,
      sheetValue: applicable ? "donor_restricted" : null,
      crmValue,
      targetType: "allocation",
      targetId: alloc?.id ?? null,
      decision: dec("usageRestriction"),
      blockedReason,
    });
  }

  // 4. Intended usage → allocation.intendedUsage.
  {
    const applicable = intendedPresent;
    let status: CrossCheckStatus = "na";
    let crmValue: string | null = null;
    let blockedReason: string | null = null;
    if (applicable) {
      if (!alloc) {
        blockedReason = allocBlocked;
        status = "na";
      } else {
        crmValue = alloc.intendedUsage;
        if (!crmValue) status = "new";
        else if (crmValue === row.intendedUsageSuggested) status = "same";
        else status = "conflict";
      }
    }
    out.push({
      attribute: "intendedUsage",
      label: "Intended usage",
      status,
      applicable,
      sheetValue: row.intendedUsageSuggested
        ? (INTENDED_USAGE_LABELS[row.intendedUsageSuggested] ??
          row.intendedUsageSuggested)
        : null,
      crmValue: crmValue
        ? (INTENDED_USAGE_LABELS[crmValue] ?? crmValue)
        : null,
      targetType: "allocation",
      targetId: alloc?.id ?? null,
      decision: dec("intendedUsage"),
      blockedReason,
    });
  }

  // 5. Donor mailing address → addresses row for the matched donor.
  {
    const applicable = !!(
      row.donorNameAddressRaw && row.donorNameAddressRaw.trim().length > 0
    );
    let status: CrossCheckStatus = "na";
    let crmValue: string | null = null;
    let targetId: string | null = null;
    let blockedReason: string | null = null;
    if (applicable) {
      if (!hasDonor(row)) {
        blockedReason = "no matched donor to attach the address to";
        status = "na";
      } else {
        const existing = await existingAddressId(row);
        if (existing) {
          // We cannot reliably compare a free-text mailing string to a
          // structured address, so surface it as a conflict for a human.
          status = "conflict";
          crmValue = "(existing address on record)";
          targetId = existing;
        } else {
          status = "new";
        }
      }
    }
    out.push({
      attribute: "address",
      label: "Donor mailing address",
      status,
      applicable,
      sheetValue: row.donorNameAddressRaw,
      crmValue,
      targetType: "address",
      targetId,
      decision: dec("address"),
      blockedReason,
    });
  }

  // 6. Coding-form reference attributes (circle / series / additional notes /
  //    internal memo) → raw copies stamped on the MATCHED GIFT, kept read-only
  //    "for looking at later". These have no structured CRM home; compare —
  //    don't clobber — against the gift's current stored reference value, and
  //    block when there is no matched gift to attach them to.
  {
    const refSpecs: Array<{
      attribute: CodingFormAttribute;
      label: string;
      sheet: string | null;
      col:
        | "codingFormCircle"
        | "codingFormSeries"
        | "codingFormAdditionalNotes"
        | "codingFormMemo";
    }> = [
      {
        attribute: "circle",
        label: "Circle / coding",
        sheet: row.circleRaw,
        col: "codingFormCircle",
      },
      {
        attribute: "seriesType",
        label: "Stand-alone vs multi-series",
        sheet: row.seriesTypeRaw,
        col: "codingFormSeries",
      },
      {
        attribute: "additionalNotes",
        label: "Additional notes",
        sheet: row.additionalNotes,
        col: "codingFormAdditionalNotes",
      },
      {
        attribute: "internalMemo",
        label: "Internal memo",
        sheet: row.internalMemo,
        col: "codingFormMemo",
      },
    ];
    const anyPresent = refSpecs.some(
      (s) => s.sheet != null && s.sheet.trim().length > 0,
    );
    let giftRef: Pick<
      typeof giftsAndPayments.$inferSelect,
      | "codingFormCircle"
      | "codingFormSeries"
      | "codingFormAdditionalNotes"
      | "codingFormMemo"
    > | null = null;
    if (anyPresent && row.matchedGiftId) {
      const [g] = await db
        .select({
          codingFormCircle: giftsAndPayments.codingFormCircle,
          codingFormSeries: giftsAndPayments.codingFormSeries,
          codingFormAdditionalNotes: giftsAndPayments.codingFormAdditionalNotes,
          codingFormMemo: giftsAndPayments.codingFormMemo,
        })
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, row.matchedGiftId))
        .limit(1);
      giftRef = g ?? null;
    }
    for (const s of refSpecs) {
      const applicable = !!(s.sheet && s.sheet.trim().length > 0);
      let status: CrossCheckStatus = "na";
      let crmValue: string | null = null;
      let blockedReason: string | null = null;
      if (applicable) {
        if (!row.matchedGiftId) {
          blockedReason =
            "no matched gift to attach the coding-form reference to";
          status = "na";
        } else if (!giftRef) {
          // matchedGiftId points at a gift that no longer exists (no FK on the
          // staging table). Block instead of silently treating it as "new".
          blockedReason = "matched gift no longer exists";
          status = "na";
        } else {
          crmValue = giftRef[s.col];
          if (!crmValue || crmValue.trim().length === 0) status = "new";
          else if (eqText(crmValue, s.sheet)) status = "same";
          else status = "conflict";
        }
      }
      out.push({
        attribute: s.attribute,
        label: s.label,
        status,
        applicable,
        sheetValue: s.sheet,
        crmValue,
        targetType: "gift",
        targetId: row.matchedGiftId,
        decision: dec(s.attribute),
        blockedReason,
      });
    }
  }

  return out;
}

// ── Serialization ────────────────────────────────────────────────────────────

export async function serializeRow(row: CodingFormRowSelect) {
  const { loadOppGrantLetter, deriveGrantAgreement } = await import(
    "./grantAgreements"
  );
  const [crossChecks, dName, oppName, oppGrant, giftName, giftCandidates] =
    await Promise.all([
      crossChecksFor(row),
      donorName(row),
      opportunityName(row.matchedOpportunityId),
      loadOppGrantLetter(row.matchedOpportunityId),
      matchedGiftName(row.matchedGiftId),
      // Live candidates only while the row is actually unresolved: pending, no
      // proposed/confirmed gift yet. Resolved rows skip the extra query.
      row.status === "pending" &&
      row.matchedGiftId == null &&
      row.matchConfirmedAt == null
        ? giftCandidatesFor(row)
        : Promise.resolve([] as GiftCandidate[]),
    ]);
  const grantAgreement = deriveGrantAgreement(row, oppGrant);
  return {
    id: row.id,
    source: row.source,
    sourceRowIndex: row.sourceRowIndex,
    status: row.status,
    donorNameRaw: row.donorNameRaw,
    internalMemo: row.internalMemo,
    amount: row.amount != null ? String(row.amount) : null,
    donationDate: row.donationDate ? String(row.donationDate) : null,
    restrictionLanguage: row.restrictionLanguage,
    donorNameAddressRaw: row.donorNameAddressRaw,
    reportRequired: row.reportRequired,
    reportDueDate: row.reportDueDate ? String(row.reportDueDate) : null,
    intendedUsageSuggested: row.intendedUsageSuggested,
    driveLink: row.driveLink,
    organizationId: row.organizationId,
    individualGiverPersonId: row.individualGiverPersonId,
    householdId: row.householdId,
    donorName: dName,
    matchedOpportunityId: row.matchedOpportunityId,
    matchedOpportunityName: oppName,
    matchedGiftId: row.matchedGiftId,
    matchedGiftName: giftName,
    matchScore: row.matchScore,
    matchMethod: row.matchMethod,
    matchTier: row.matchTier,
    matchConfirmedAt: row.matchConfirmedAt?.toISOString() ?? null,
    giftCandidates,
    crossChecks,
    needsDecision: needsDecisionFor(row),
    grantAgreement,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    appliedTaskId: row.appliedTaskId,
    appliedAddressId: row.appliedAddressId,
    appliedAllocationId: row.appliedAllocationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyOutcome {
  applied: string[];
  skipped: string[];
}

/**
 * The attributes an apply call would actually write: reviewer-approved AND
 * classified `new`/`conflict` by the live cross-check AND not blocked by an
 * unresolved match/allocation. `same`, `na`, blocked, and skip-decision
 * attributes are excluded. This is the "is there anything actionable?" gate the
 * apply route checks before mutating CRM state.
 */
export function actionableAttributes(
  checks: CrossCheck[],
  decisions: Record<string, "apply" | "skip">,
): CodingFormAttribute[] {
  return checks
    .filter(
      (c) =>
        c.applicable &&
        !c.blockedReason &&
        decisions[c.attribute] === "apply" &&
        (c.status === "new" || c.status === "conflict"),
    )
    .map((c) => c.attribute);
}

export type ApplyResult =
  | { kind: "applied"; applied: string[]; skipped: string[] }
  | { kind: "noop" } // already applied; nothing left to write (idempotent re-run)
  | { kind: "nothing_to_apply" }; // no approved+actionable attribute → 409

/**
 * Apply the reviewer-approved attributes for a row through the normal
 * create/update paths. Compare-don't-clobber: only writes a value that the live
 * cross-check classifies as `new`, or a `conflict` the reviewer explicitly chose
 * to apply. Idempotent: a second run sees the value already present (→ `same`)
 * and skips.
 *
 * Apply integrity: a row is NOT marked `applied` unless at least one approved
 * attribute is genuinely actionable. If nothing is actionable the row is left
 * untouched and the caller returns 409 (`nothing_to_apply`) — except an
 * already-applied row, which is a safe `noop` so re-running stays idempotent.
 */
export async function applyRow(
  row: CodingFormRowSelect,
  decisions: Record<string, "apply" | "skip">,
  userId: string | null,
): Promise<ApplyResult> {
  const checks = await crossChecksFor(row);
  const wanted = new Set(actionableAttributes(checks, decisions));
  if (wanted.size === 0) {
    return { kind: row.status === "applied" ? "noop" : "nothing_to_apply" };
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  let appliedTaskId = row.appliedTaskId;
  let appliedAddressId = row.appliedAddressId;
  let appliedAllocationId = row.appliedAllocationId;
  let touchedPledgeOppId: string | null = null;
  let touchedGiftId: string | null = null;

  const want = (a: CodingFormAttribute): boolean => wanted.has(a);

  // 1. Reporting deadline → reporting_deadline task.
  if (want("reportDeadline") && row.matchedOpportunityId && row.reportDueDate) {
    const dueDate = String(row.reportDueDate);
    const existing = await existingReportingTask(
      row.matchedOpportunityId,
      dueDate,
    );
    if (existing) {
      appliedTaskId = existing;
      skipped.push("reportDeadline");
    } else if (userId) {
      const [task] = await db
        .insert(tasks)
        .values({
          id: newId(),
          title: row.donorNameRaw
            ? `Reporting deadline — ${row.donorNameRaw}`
            : "Reporting deadline",
          kind: "reporting_deadline",
          status: "open",
          dueDate,
          opportunityIds: [row.matchedOpportunityId],
          createdByUserId: userId,
        })
        .returning();
      appliedTaskId = task.id;
      applied.push("reportDeadline");
    } else {
      skipped.push("reportDeadline");
    }
  }

  // 2-4. Allocation attributes (purpose / usage axis / intended usage).
  const allocAttrs: CodingFormAttribute[] = [
    "purposeVerbatim",
    "usageRestriction",
    "intendedUsage",
  ];
  const allocToApply = allocAttrs.filter((a) => want(a));
  if (allocToApply.length > 0) {
    const { alloc } = await resolveAllocation(row);
    if (alloc) {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (allocToApply.includes("purposeVerbatim"))
        patch.purposeVerbatim = row.restrictionLanguage;
      if (allocToApply.includes("usageRestriction"))
        patch.usageRestrictionType = "donor_restricted";
      if (allocToApply.includes("intendedUsage"))
        patch.intendedUsage = row.intendedUsageSuggested;
      if (alloc.kind === "gift") {
        await db
          .update(giftAllocations)
          .set(patch)
          .where(eq(giftAllocations.id, alloc.id));
        touchedGiftId = row.matchedGiftId;
      } else {
        await db
          .update(pledgeAllocations)
          .set(patch)
          .where(eq(pledgeAllocations.id, alloc.id));
        touchedPledgeOppId = row.matchedOpportunityId;
      }
      appliedAllocationId = alloc.id;
      applied.push(...allocToApply);
    } else {
      skipped.push(...allocToApply);
    }
  }

  // 5. Donor mailing address → addresses row (create only when none exists, or a
  //    reviewer-approved conflict). Conservative: store the raw mailing string as
  //    the street line plus any confidently parsed postal/state/city.
  if (want("address") && hasDonor(row)) {
    // Idempotency: if we already created an address that still exists, reuse it.
    let reuse: string | null = null;
    if (appliedAddressId) {
      const r = await db
        .select({ id: addresses.id })
        .from(addresses)
        .where(eq(addresses.id, appliedAddressId))
        .limit(1);
      reuse = r[0]?.id ?? null;
    }
    if (reuse) {
      skipped.push("address");
    } else {
      const id = newId();
      await db.insert(addresses).values({
        id,
        street: row.donorNameAddressRaw,
        cityName: row.addrCity,
        stateCode: row.addrState,
        postalCode: row.addrPostal,
        country: row.addrCountry,
        organizationId: row.organizationId,
        personId: row.individualGiverPersonId,
        householdId: row.householdId,
      });
      appliedAddressId = id;
      applied.push("address");
    }
  }

  // 6. Coding-form reference attributes → raw copies on the matched gift.
  //    Compare-don't-clobber already happened in the cross-check; here we just
  //    write the reviewer-approved actionable ones onto the gift row.
  const refApply: Array<{
    attr: CodingFormAttribute;
    col:
      | "codingFormCircle"
      | "codingFormSeries"
      | "codingFormAdditionalNotes"
      | "codingFormMemo";
    value: string | null;
  }> = [
    { attr: "circle", col: "codingFormCircle", value: row.circleRaw },
    { attr: "seriesType", col: "codingFormSeries", value: row.seriesTypeRaw },
    {
      attr: "additionalNotes",
      col: "codingFormAdditionalNotes",
      value: row.additionalNotes,
    },
    { attr: "internalMemo", col: "codingFormMemo", value: row.internalMemo },
  ];
  const refToApply = refApply.filter((r) => want(r.attr));
  if (refToApply.length > 0 && row.matchedGiftId) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const r of refToApply) patch[r.col] = r.value;
    // Self-verifying write: if the matched gift vanished between the cross-check
    // and here, the update touches zero rows — mark skipped, never applied.
    const updated = await db
      .update(giftsAndPayments)
      .set(patch)
      .where(eq(giftsAndPayments.id, row.matchedGiftId))
      .returning({ id: giftsAndPayments.id });
    if (updated.length > 0) applied.push(...refToApply.map((r) => r.attr));
    else skipped.push(...refToApply.map((r) => r.attr));
  }

  // Persist merged decisions + applied artifact ids + status.
  const mergedDecisions = {
    ...((row.decisions ?? {}) as Record<string, string>),
    ...decisions,
  };
  await db
    .update(codingFormRows)
    .set({
      decisions: mergedDecisions,
      status: "applied",
      appliedAt: new Date(),
      appliedByUserId: userId,
      appliedTaskId,
      appliedAddressId,
      appliedAllocationId,
      updatedAt: new Date(),
    })
    .where(eq(codingFormRows.id, row.id));

  // Re-derive through the derive-aware paths so opportunity status / QB tie stay
  // correct even though restriction edits don't change those today.
  if (touchedGiftId) {
    const { applyGiftQbTieMany } = await import("./giftQbTie");
    await applyGiftQbTieMany(touchedGiftId);
  }
  if (touchedPledgeOppId) {
    const { applyDerivedOppFields } = await import("./pledgeStage");
    await applyDerivedOppFields(touchedPledgeOppId);
  }

  return { kind: "applied", applied, skipped };
}
