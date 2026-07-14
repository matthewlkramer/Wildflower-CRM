/**
 * READ-ONLY conflict analysis for the one-time donation coding-form import
 * (companion to migration 0100's data seed).
 *
 * For every already-seeded `coding_form_rows` row it computes a FRESH proposed
 * match against current CRM state (the exact same matcher the app uses —
 * `computeProposedMatch`, which wraps `scoreStagedPayment` + the same-donor
 * opportunity pick), then runs the app's live cross-check (`crossChecksFor`) plus
 * a money / QuickBooks comparison against the matched gift (and the QB staged
 * payment behind it), and writes one CSV row per coding-form row — including
 * `no_match` rows so nothing is hidden.
 *
 * Each money attribute is emitted as an explicit sheet / system / conflict triple
 * so the CSV is self-sufficient for manual remediation without opening the app:
 *   amount, donation date, deposit date, payment method, and the QuickBooks tie.
 *
 * It NEVER writes: it only calls the read-only compute path (never `rematchRow` /
 * `applyRow`) and issues SELECT-only queries. Run it against whichever database
 * `DATABASE_URL` points at — for the production analysis, point DATABASE_URL at
 * prod for this one invocation:
 *
 *   DATABASE_URL="$PROD_DATABASE_URL" \
 *     pnpm --filter @workspace/api-server run analyze:coding-form-conflicts
 *
 * Output: `coding-form-conflicts.csv` at the repo root (override with argv[2]).
 *
 * NOTE (per .agents/memory): live QuickBooks/Stripe money + recently-changed CRM
 * rows live in PROD, not dev — running this against dev will show sparse matches
 * and few money conflicts. That is expected; the meaningful pass is against prod.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "@workspace/db";
import {
  codingFormRows,
  giftsAndPayments,
  stagedPayments,
  organizations,
  people,
  households,
  paymentApplications,
} from "@workspace/db/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  computeProposedMatch,
  crossChecksFor,
  type CodingFormRowSelect,
} from "../lib/codingForms";

// Two amounts tie if within a cent.
const AMOUNT_TOLERANCE = 0.01;
// A matched gift's date should land near the sheet's date; wider than the
// reconciliation window because coding forms are filed by hand well after the
// gift.
const DATE_WINDOW_DAYS = 45;

type MatchStatus = "no_match" | "donor_only" | "opportunity" | "gift";

function matchStatusOf(m: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  matchedGiftId: string | null;
  matchedOpportunityId: string | null;
}): MatchStatus {
  if (m.matchedGiftId) return "gift";
  if (m.matchedOpportunityId) return "opportunity";
  if (m.organizationId || m.individualGiverPersonId || m.householdId)
    return "donor_only";
  return "no_match";
}

function donorKindId(m: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}): { kind: string; id: string | null } {
  if (m.organizationId) return { kind: "organization", id: m.organizationId };
  if (m.individualGiverPersonId)
    return { kind: "person", id: m.individualGiverPersonId };
  if (m.householdId) return { kind: "household", id: m.householdId };
  return { kind: "", id: null };
}

async function donorNameOf(m: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}): Promise<string | null> {
  if (m.organizationId) {
    const [r] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, m.organizationId))
      .limit(1);
    return r?.name ?? null;
  }
  if (m.individualGiverPersonId) {
    const [r] = await db
      .select({ name: people.fullName })
      .from(people)
      .where(eq(people.id, m.individualGiverPersonId))
      .limit(1);
    return r?.name ?? null;
  }
  if (m.householdId) {
    const [r] = await db
      .select({ name: households.name })
      .from(households)
      .where(eq(households.id, m.householdId))
      .limit(1);
    return r?.name ?? null;
  }
  return null;
}

function daysBetween(a: string, b: string): number | null {
  const da = Date.parse(a);
  const db2 = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db2)) return null;
  return Math.abs(da - db2) / 86_400_000;
}

/**
 * Coarse payment-method family so a free-text sheet value ("Check #123",
 * "Credit card", "Stripe") can be compared to the gift enum / QB instrument
 * without noise. Returns null when the text maps to nothing recognizable — an
 * unknown family is left uncompared (raw values still land in the CSV) rather
 * than flagged as a false conflict.
 */
function pmFamily(v: string | null): string | null {
  if (!v) return null;
  const s = v.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s.includes("daf")) return "daf";
  if (s.includes("donorbox")) return "donor_box";
  if (s.includes("check") || s.includes("cheque") || s.includes("chk"))
    return "check";
  if (s.includes("ach") || s.includes("bank") || s.includes("eft"))
    return "ach";
  if (s.includes("wire")) return "wire";
  if (s.includes("stock") || s.includes("securit") || s.includes("shares"))
    return "stock";
  if (s.includes("bill")) return "ach";
  if (
    s.includes("card") ||
    s.includes("credit") ||
    s.includes("stripe") ||
    s.includes("cc")
  )
    return "card";
  if (s.includes("paypal")) return "paypal";
  if (s.includes("cash")) return "cash";
  if (s.includes("venmo")) return "venmo";
  return null;
}

function csvCell(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const HEADER = [
  "id",
  "source",
  "source_row_index",
  "donor_name_raw",
  "match_status",
  "match_tier",
  "match_score",
  "match_method",
  "donor_kind",
  "donor_id",
  "donor_name",
  "matched_opportunity_id",
  "matched_gift_id",
  // amount
  "amount_sheet",
  "amount_system",
  "amount_conflict",
  // donation date (sheet) vs gift date_received
  "donation_date_sheet",
  "donation_date_system",
  "donation_date_conflict",
  // deposit date (sheet) vs linked QB staged-payment date
  "deposit_date_sheet",
  "deposit_date_system",
  "deposit_date_conflict",
  // payment method (sheet) vs gift.payment_method / QB instrument
  "payment_method_sheet",
  "payment_method_system",
  "payment_method_conflict",
  // QuickBooks tie
  "qb_tie_status",
  "qb_tie_conflict",
  // qualitative cross-checks
  "attribute_conflicts",
  "attribute_new",
  "blocked",
  "has_conflict",
] as const;

async function main(): Promise<void> {
  const outPath = path.resolve(
    process.argv[2] ?? path.join(process.cwd(), "coding-form-conflicts.csv"),
  );

  const rows = await db
    .select()
    .from(codingFormRows)
    .orderBy(asc(codingFormRows.source), asc(codingFormRows.sourceRowIndex));

  const lines: string[] = [HEADER.join(",")];
  const summary = {
    total: rows.length,
    no_match: 0,
    donor_only: 0,
    opportunity: 0,
    gift: 0,
    with_conflict: 0,
    amount_conflicts: 0,
    donation_date_conflicts: 0,
    deposit_date_conflicts: 0,
    payment_method_conflicts: 0,
    qb_conflicts: 0,
    attribute_conflicts: 0,
  };

  for (const dbRow of rows) {
    // FRESH match against live CRM (read-only) merged onto an in-memory row so
    // the cross-check reflects the current proposal, not any stored decision.
    const match = await computeProposedMatch(dbRow);
    const row = { ...dbRow, ...match } as CodingFormRowSelect;
    const status = matchStatusOf(match);
    summary[status] += 1;

    const donorName = await donorNameOf(match);

    const checks = await crossChecksFor(row);
    const attrConflicts = checks
      .filter((c) => c.applicable && c.status === "conflict")
      .map(
        (c) => `${c.attribute}: sheet=[${c.sheetValue ?? ""}] crm=[${c.crmValue ?? ""}]`,
      );
    const attrNew = checks
      .filter((c) => c.applicable && c.status === "new")
      .map((c) => c.attribute);
    const blocked = checks
      .filter((c) => c.applicable && c.blockedReason)
      .map((c) => `${c.attribute}: ${c.blockedReason}`);

    // Money / QuickBooks comparison against the matched gift (+ its QB staged
    // payment for the deposit date / instrument the sheet can be checked against).
    let giftAmount: string | null = null;
    let giftDate: string | null = null;
    let giftMethod: string | null = null;
    let qbTie: string | null = null;
    let stagedDate: string | null = null;
    let stagedMethod: string | null = null;

    let amountConflict = "";
    let donationDateConflict = "";
    let depositDateConflict = "";
    let paymentMethodConflict = "";
    let qbConflict = "";

    if (match.matchedGiftId) {
      const [g] = await db
        .select({
          amount: giftsAndPayments.amount,
          dateReceived: giftsAndPayments.dateReceived,
          method: giftsAndPayments.paymentMethod,
          tie: giftsAndPayments.quickbooksTieStatus,
        })
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, match.matchedGiftId))
        .limit(1);
      // The QB staged payment behind this gift (linked, minted, grouped, or
      // split — resolved through the counted cash-application ledger; the
      // legacy staged gift-link columns are @deprecated and no longer written)
      // — carries the QB instrument + txn/deposit date to check the sheet
      // against.
      const [sp] = await db
        .select({
          dateReceived: stagedPayments.dateReceived,
          qbMethod: stagedPayments.qbPaymentMethod,
        })
        .from(paymentApplications)
        .innerJoin(
          stagedPayments,
          eq(stagedPayments.id, paymentApplications.paymentId),
        )
        .where(
          and(
            eq(paymentApplications.giftId, match.matchedGiftId),
            eq(paymentApplications.evidenceSource, "quickbooks"),
            eq(paymentApplications.linkRole, "counted"),
          ),
        )
        .limit(1);

      if (g) {
        giftAmount = g.amount;
        giftDate = g.dateReceived;
        giftMethod = g.method;
        qbTie = g.tie;
      }
      if (sp) {
        stagedDate = sp.dateReceived;
        stagedMethod = sp.qbMethod;
      }

      // amount: sheet vs gift.amount
      if (dbRow.amount != null && giftAmount != null) {
        const diff = Math.abs(Number(dbRow.amount) - Number(giftAmount));
        if (diff > AMOUNT_TOLERANCE) {
          amountConflict = `Δ${diff.toFixed(2)}`;
          summary.amount_conflicts += 1;
        }
      }

      // donation date: sheet vs gift.date_received
      if (dbRow.donationDate && giftDate) {
        const d = daysBetween(String(dbRow.donationDate), giftDate);
        if (d != null && d > DATE_WINDOW_DAYS) {
          donationDateConflict = `${Math.round(d)}d apart`;
          summary.donation_date_conflicts += 1;
        }
      }

      // deposit date: sheet vs linked QB staged-payment date (deposit proxy)
      if (dbRow.depositDate && stagedDate) {
        const d = daysBetween(String(dbRow.depositDate), stagedDate);
        if (d != null && d > DATE_WINDOW_DAYS) {
          depositDateConflict = `${Math.round(d)}d apart`;
          summary.deposit_date_conflicts += 1;
        }
      }

      // payment method: sheet (free text) vs gift enum / QB instrument, by family
      const sheetFam = pmFamily(dbRow.paymentMethodRaw);
      const sysFam = pmFamily(giftMethod ?? stagedMethod);
      if (sheetFam && sysFam && sheetFam !== sysFam) {
        paymentMethodConflict = `${sheetFam}≠${sysFam}`;
        summary.payment_method_conflicts += 1;
      }

      // QuickBooks tie
      if (qbTie === "amount_mismatch" || qbTie === "missing") {
        qbConflict = qbTie;
        summary.qb_conflicts += 1;
      }
    }

    if (attrConflicts.length > 0) summary.attribute_conflicts += 1;
    const hasConflict =
      attrConflicts.length > 0 ||
      amountConflict !== "" ||
      donationDateConflict !== "" ||
      depositDateConflict !== "" ||
      paymentMethodConflict !== "" ||
      qbConflict !== "";
    if (hasConflict) summary.with_conflict += 1;

    const { kind, id } = donorKindId(match);
    lines.push(
      [
        dbRow.id,
        dbRow.source,
        dbRow.sourceRowIndex,
        dbRow.donorNameRaw,
        status,
        match.matchTier,
        match.matchScore,
        match.matchMethod,
        kind,
        id,
        donorName,
        match.matchedOpportunityId,
        match.matchedGiftId,
        // amount
        dbRow.amount,
        giftAmount,
        amountConflict,
        // donation date
        dbRow.donationDate ? String(dbRow.donationDate) : null,
        giftDate,
        donationDateConflict,
        // deposit date
        dbRow.depositDate ? String(dbRow.depositDate) : null,
        stagedDate,
        depositDateConflict,
        // payment method
        dbRow.paymentMethodRaw,
        giftMethod ?? stagedMethod,
        paymentMethodConflict,
        // qb tie
        qbTie,
        qbConflict,
        // qualitative
        attrConflicts.join(" | "),
        attrNew.join(", "),
        blocked.join(" | "),
        hasConflict ? "yes" : "no",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`Wrote ${rows.length} rows to ${outPath}`);
  console.log("Summary:", JSON.stringify(summary, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
