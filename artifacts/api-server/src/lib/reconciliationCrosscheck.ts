// Historical Transaction Reconciliation Cross-Check (READ-ONLY).
//
// Compares the normalized spreadsheet snapshot (reconciliationCrosscheckData.ts)
// against the CRM's already-synced money records and classifies every sheet row
// as `matched`, `amount_mismatch`, or `missing`. This NEVER writes — it mints no
// gifts, stages no payments, and touches no Stripe/QuickBooks record. It is a
// diagnostic that surfaces where the historical exports and the CRM disagree.
//
// Matching strategy:
//   • Stripe rows (stripe_donorbox / stripe_815) carry a Stripe charge id — the
//     strongest possible key. We look the charge up directly in
//     stripe_staged_charges and compare gross amounts.
//   • QuickBooks rows (qbo_fy25) have no charge id, so we fall back to the
//     donor-name + amount + date heuristic against gifts_and_payments and
//     staged_payments (the same signals the live reconciler uses).

import { db } from "@workspace/db";
import {
  stripeStagedCharges,
  giftsAndPayments,
  stagedPayments,
  organizations,
  people,
  households,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  reconciliationCrosscheckRows,
  type ReconciliationCrosscheckSourceRow,
  type ReconciliationCrosscheckSource,
} from "../data/reconciliationCrosscheckData";

export type ReconciliationClassification =
  | "matched"
  | "amount_mismatch"
  | "missing";

export type ReconciliationCrmRecordKind =
  | "stripe_charge"
  | "gift"
  | "staged_payment";

export interface ClassifiedCrosscheckRow
  extends ReconciliationCrosscheckSourceRow {
  classification: ReconciliationClassification;
  /** Human-readable explanation of how (or why not) the row was matched. */
  matchBasis: string;
  /** The CRM amount we compared the sheet gross against (when one was found). */
  crmAmount: number | null;
  crmRecordKind: ReconciliationCrmRecordKind | null;
  crmRecordId: string | null;
}

export interface ReconciliationSourceSummary {
  source: ReconciliationCrosscheckSource;
  total: number;
  matched: number;
  amountMismatch: number;
  missing: number;
  /** Sum of sheet gross over all rows of this source. */
  sheetTotalAmount: number;
  /** Sum of sheet gross over `missing` rows (the unreconciled gap). */
  missingAmount: number;
  /** Sum of sheet gross over `amount_mismatch` rows. */
  mismatchAmount: number;
}

export interface ReconciliationGapBucket {
  source: ReconciliationCrosscheckSource;
  /** yyyy-mm of the sheet date, or "unknown" when the row has no date. */
  month: string;
  missingCount: number;
  missingAmount: number;
}

export interface ReconciliationCrosscheckResult {
  rows: ClassifiedCrosscheckRow[];
  bySource: ReconciliationSourceSummary[];
  gaps: ReconciliationGapBucket[];
}

// Gross amounts compared within a cent to absorb floating-point noise.
const AMOUNT_TOLERANCE = 0.01;
// QBO name+amount matches must fall inside this many days of the sheet date.
const DATE_WINDOW_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

// PROD VERIFICATION (read-only pass against the live money records — see
// .agents/memory/reconciliation-crosscheck-prod-verification.md). Against prod the
// report is broadly trustworthy: all 39 Stripe rows match by charge id and the 84
// QBO name+amount+date matches spot-check clean. Three accuracy gaps were found,
// each worth tuning before the team fully relies on the gap totals:
//   1. DATE_WINDOW_DAYS = 45 is too tight — it produced the lone "missing" row
//      (Chia Rodeski $7,000): the real CRM gift exists 54 days from the sheet
//      date. The live reconciler uses 60–90d windows; widen this to ~60–90.
//   2. The "amount + date only" path (uncorroborated name) yielded 16 weak QBO
//      matches (~$1.18M abs), 14 with a blank sheet donor; it grabs the first
//      same-amount CRM record (often an unrelated donor) and even matched a $0
//      row and an abs()'d -$500k reclassification. Guard zero/negative amounts
//      and treat amount-only hits as a distinct "weak/uncertain" bucket, not
//      "matched".
//   3. No one-to-one consumption: 27 CRM records were each claimed by >=2 sheet
//      rows. Most are genuine sheet self-duplicates (one Stripe transfer listed
//      twice), so the sheet total double-counts and the matched COUNT overstates
//      distinct reconciled money.

interface CrmCandidate {
  kind: "gift" | "staged_payment";
  id: string;
  amount: number | null;
  amountCents: number | null;
  date: number | null; // epoch ms (UTC midnight) or null
  names: string[]; // normalized donor / payer names
}

function toNum(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function amountCentsOf(v: number | null): number | null {
  return v == null ? null : Math.round(Math.abs(v) * 100);
}

function dateMs(v: string | null): number | null {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00Z`);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function monthOf(v: string | null): string {
  return v && /^\d{4}-\d{2}/.test(v) ? v.slice(0, 7) : "unknown";
}

export function normalizeName(s: string | null): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameTokens(s: string | null): string[] {
  return normalizeName(s)
    .split(" ")
    .filter((t) => t.length >= 4);
}

// Two names corroborate when their normalized forms share at least one token of
// length >= 4, or one normalized form contains the other.
export function namesCorroborate(a: string, candidateNames: string[]): boolean {
  const an = normalizeName(a);
  if (!an) return false;
  const aTokens = new Set(nameTokens(a));
  for (const cand of candidateNames) {
    if (!cand) continue;
    if (cand.includes(an) || an.includes(cand)) return true;
    for (const t of cand.split(" ")) {
      if (t.length >= 4 && aTokens.has(t)) return true;
    }
  }
  return false;
}

function withinWindow(rowDate: number | null, candDate: number | null): boolean {
  // Null on either side is date-tolerant (QBO rows always have a date; some CRM
  // rows do not, and we don't want a missing CRM date to hide a real match).
  if (rowDate == null || candDate == null) return true;
  return Math.abs(rowDate - candDate) <= DATE_WINDOW_DAYS * DAY_MS;
}

// ── Pure Stripe classifier ───────────────────────────────────────────────────
export function classifyStripeRow(
  row: ReconciliationCrosscheckSourceRow,
  chargeIndex: Map<string, { gross: number | null }>,
): ClassifiedCrosscheckRow {
  const base = baseRow(row);
  if (!row.stripeChargeId) {
    return {
      ...base,
      classification: "missing",
      matchBasis: "No Stripe charge id on the row (e.g. PayPal / Donorbox-only).",
    };
  }
  const crm = chargeIndex.get(row.stripeChargeId);
  if (!crm) {
    return {
      ...base,
      classification: "missing",
      matchBasis: "Stripe charge id not present in the CRM's synced charges.",
    };
  }
  const crmGross = crm.gross;
  if (
    row.grossAmount != null &&
    crmGross != null &&
    Math.abs(row.grossAmount - crmGross) <= AMOUNT_TOLERANCE
  ) {
    return {
      ...base,
      classification: "matched",
      matchBasis: "Matched by Stripe charge id (gross amounts agree).",
      crmAmount: crmGross,
      crmRecordKind: "stripe_charge",
      crmRecordId: row.stripeChargeId,
    };
  }
  return {
    ...base,
    classification: "amount_mismatch",
    matchBasis: "Stripe charge id found, but the gross amount differs.",
    crmAmount: crmGross,
    crmRecordKind: "stripe_charge",
    crmRecordId: row.stripeChargeId,
  };
}

// ── Pure QuickBooks classifier ───────────────────────────────────────────────
export function classifyQboRow(
  row: ReconciliationCrosscheckSourceRow,
  amountIndex: Map<number, CrmCandidate[]>,
  nameIndex: Map<string, CrmCandidate[]>,
): ClassifiedCrosscheckRow {
  const base = baseRow(row);
  const cents = amountCentsOf(row.grossAmount);
  const rowMs = dateMs(row.date);

  if (cents == null) {
    return {
      ...base,
      classification: "missing",
      matchBasis: "Row has no amount to match against.",
    };
  }

  // 1. Exact amount + date window.
  const amtCands = (amountIndex.get(cents) ?? []).filter((c) =>
    withinWindow(rowMs, c.date),
  );
  const nameMatch = row.donorName
    ? amtCands.find((c) => namesCorroborate(row.donorName as string, c.names))
    : undefined;
  if (nameMatch) {
    return {
      ...base,
      classification: "matched",
      matchBasis: "Matched by donor name + amount + date.",
      crmAmount: nameMatch.amount,
      crmRecordKind: nameMatch.kind,
      crmRecordId: nameMatch.id,
    };
  }
  if (amtCands.length > 0) {
    const c = amtCands[0];
    return {
      ...base,
      classification: "matched",
      matchBasis: "Matched by amount + date (donor name not corroborated).",
      crmAmount: c.amount,
      crmRecordKind: c.kind,
      crmRecordId: c.id,
    };
  }

  // 2. Name + date matched, but amount differs → amount_mismatch.
  if (row.donorName) {
    const seen = new Set<string>();
    const nameCands: CrmCandidate[] = [];
    for (const tok of nameTokens(row.donorName)) {
      for (const c of nameIndex.get(tok) ?? []) {
        const k = `${c.kind}:${c.id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        nameCands.push(c);
      }
    }
    const mismatch = nameCands.find(
      (c) =>
        withinWindow(rowMs, c.date) &&
        c.amountCents != null &&
        c.amountCents !== cents &&
        namesCorroborate(row.donorName as string, c.names),
    );
    if (mismatch) {
      return {
        ...base,
        classification: "amount_mismatch",
        matchBasis: "Donor name + date matched a CRM record, but the amount differs.",
        crmAmount: mismatch.amount,
        crmRecordKind: mismatch.kind,
        crmRecordId: mismatch.id,
      };
    }
  }

  return {
    ...base,
    classification: "missing",
    matchBasis: "No CRM gift or staged payment matched name + amount + date.",
  };
}

function baseRow(row: ReconciliationCrosscheckSourceRow): ClassifiedCrosscheckRow {
  return {
    ...row,
    classification: "missing",
    matchBasis: "",
    crmAmount: null,
    crmRecordKind: null,
    crmRecordId: null,
  };
}

// ── DB-touching orchestrator (read-only) ─────────────────────────────────────
export async function runReconciliationCrosscheck(): Promise<ReconciliationCrosscheckResult> {
  // Stripe charge index keyed by charge id (the PK of stripe_staged_charges).
  const chargeRows = await db
    .select({
      id: stripeStagedCharges.id,
      gross: stripeStagedCharges.grossAmount,
    })
    .from(stripeStagedCharges);
  const chargeIndex = new Map<string, { gross: number | null }>();
  for (const c of chargeRows) {
    chargeIndex.set(c.id, { gross: toNum(c.gross) });
  }

  // CRM candidates for the QBO name/amount/date heuristic: gifts + staged
  // payments, each with their donor (and payer) display names.
  const giftRows = await db
    .select({
      id: giftsAndPayments.id,
      amount: giftsAndPayments.amount,
      date: giftsAndPayments.dateReceived,
      orgName: organizations.name,
      personName: people.fullName,
      householdName: households.name,
    })
    .from(giftsAndPayments)
    .leftJoin(
      organizations,
      eq(giftsAndPayments.organizationId, organizations.id),
    )
    .leftJoin(people, eq(giftsAndPayments.individualGiverPersonId, people.id))
    .leftJoin(households, eq(giftsAndPayments.householdId, households.id));

  const stagedRows = await db
    .select({
      id: stagedPayments.id,
      amount: stagedPayments.amount,
      date: stagedPayments.dateReceived,
      payerName: stagedPayments.payerName,
      orgName: organizations.name,
      personName: people.fullName,
      householdName: households.name,
    })
    .from(stagedPayments)
    .leftJoin(organizations, eq(stagedPayments.organizationId, organizations.id))
    .leftJoin(people, eq(stagedPayments.individualGiverPersonId, people.id))
    .leftJoin(households, eq(stagedPayments.householdId, households.id));

  const candidates: CrmCandidate[] = [];
  for (const g of giftRows) {
    const amount = toNum(g.amount);
    candidates.push({
      kind: "gift",
      id: g.id,
      amount,
      amountCents: amountCentsOf(amount),
      date: dateMs(g.date),
      names: [g.orgName, g.personName, g.householdName]
        .map((n) => normalizeName(n))
        .filter((n) => n.length > 0),
    });
  }
  for (const s of stagedRows) {
    const amount = toNum(s.amount);
    candidates.push({
      kind: "staged_payment",
      id: s.id,
      amount,
      amountCents: amountCentsOf(amount),
      date: dateMs(s.date),
      names: [s.payerName, s.orgName, s.personName, s.householdName]
        .map((n) => normalizeName(n))
        .filter((n) => n.length > 0),
    });
  }

  const amountIndex = new Map<number, CrmCandidate[]>();
  const nameIndex = new Map<string, CrmCandidate[]>();
  for (const c of candidates) {
    if (c.amountCents != null) {
      const arr = amountIndex.get(c.amountCents);
      if (arr) arr.push(c);
      else amountIndex.set(c.amountCents, [c]);
    }
    const tokens = new Set<string>();
    for (const n of c.names) for (const t of nameTokens(n)) tokens.add(t);
    for (const t of tokens) {
      const arr = nameIndex.get(t);
      if (arr) arr.push(c);
      else nameIndex.set(t, [c]);
    }
  }

  const rows: ClassifiedCrosscheckRow[] = reconciliationCrosscheckRows.map(
    (row) =>
      row.source === "qbo_fy25"
        ? classifyQboRow(row, amountIndex, nameIndex)
        : classifyStripeRow(row, chargeIndex),
  );

  return {
    rows,
    bySource: summarize(rows),
    gaps: computeGaps(rows),
  };
}

function summarize(
  rows: ClassifiedCrosscheckRow[],
): ReconciliationSourceSummary[] {
  const bySource = new Map<
    ReconciliationCrosscheckSource,
    ReconciliationSourceSummary
  >();
  const ensure = (
    source: ReconciliationCrosscheckSource,
  ): ReconciliationSourceSummary => {
    let s = bySource.get(source);
    if (!s) {
      s = {
        source,
        total: 0,
        matched: 0,
        amountMismatch: 0,
        missing: 0,
        sheetTotalAmount: 0,
        missingAmount: 0,
        mismatchAmount: 0,
      };
      bySource.set(source, s);
    }
    return s;
  };
  for (const r of rows) {
    const s = ensure(r.source);
    s.total += 1;
    s.sheetTotalAmount += r.grossAmount ?? 0;
    if (r.classification === "matched") s.matched += 1;
    else if (r.classification === "amount_mismatch") {
      s.amountMismatch += 1;
      s.mismatchAmount += r.grossAmount ?? 0;
    } else {
      s.missing += 1;
      s.missingAmount += r.grossAmount ?? 0;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return [...bySource.values()].map((s) => ({
    ...s,
    sheetTotalAmount: round(s.sheetTotalAmount),
    missingAmount: round(s.missingAmount),
    mismatchAmount: round(s.mismatchAmount),
  }));
}

function computeGaps(
  rows: ClassifiedCrosscheckRow[],
): ReconciliationGapBucket[] {
  const map = new Map<string, ReconciliationGapBucket>();
  for (const r of rows) {
    if (r.classification !== "missing") continue;
    const month = monthOf(r.date);
    const key = `${r.source}|${month}`;
    let g = map.get(key);
    if (!g) {
      g = { source: r.source, month, missingCount: 0, missingAmount: 0 };
      map.set(key, g);
    }
    g.missingCount += 1;
    g.missingAmount += r.grossAmount ?? 0;
  }
  return [...map.values()]
    .map((g) => ({ ...g, missingAmount: Math.round(g.missingAmount * 100) / 100 }))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.month.localeCompare(b.month),
    );
}
