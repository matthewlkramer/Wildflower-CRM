import { db } from "@workspace/db";
import {
  opportunitiesAndPledges,
  giftsAndPayments,
  pledgeAllocations,
} from "@workspace/db/schema";
import { and, isNull, isNotNull, sql } from "drizzle-orm";
import {
  deriveOppFields,
  canonicalWinProbability,
  rollupConditional,
} from "./pledgeStage";

/**
 * Derivation health check (REPORT-ONLY — never writes).
 *
 * Persisted-derived fields are correct only if every write path that touches
 * their inputs remembers to re-run the derivation applier
 * (`applyDerivedOppFieldsMany`). That is convention, not enforcement. This
 * check re-derives every persisted-derived field from its inputs — through the
 * SAME pure functions and queries the appliers use, never a mirrored
 * reimplementation — and reports any row where stored ≠ derived. Silent drift
 * becomes a visible report and a tripwire for any future forgotten applier call.
 *
 * Checked fields:
 *  - opportunities_and_pledges: status, stage, written_pledge, paid,
 *    win_probability (win_probability only where the canonical value is
 *    authoritative — pledge / cash_in / lost / dormant. On OPEN rows a stored
 *    value differing from the stage weight is a legitimate user override,
 *    not drift — but a NULL is never an override: every row must carry a
 *    weight, so a NULL on an open row IS reported as drift.)
 *
 * NOTE: quickbooks_tie_status is no longer checked here — it is now derived
 * LIVE at query time (Task #451) and has no stored value to validate.
 *
 * Scope: non-archived rows only (archived rows are logically deleted; their
 * derived fields are inert).
 */

export interface DerivationDriftRow {
  table: "opportunities_and_pledges" | "gifts_and_payments";
  id: string;
  name: string | null;
  field: string;
  stored: string | null;
  derived: string | null;
}

export interface DerivationHealthReport {
  ranAt: string;
  durationMs: number;
  checkedOpportunities: number;
  driftCount: number;
  /** Per-field drift totals, e.g. { status: 3, paid: 1 } (uncapped). */
  byField: Record<string, number>;
  /** Drift detail rows, capped at MAX_REPORT_ROWS. */
  drift: DerivationDriftRow[];
  truncated: boolean;
}

const MAX_REPORT_ROWS = 200;

function numEq(a: string | number | null, b: string | number | null): boolean {
  // Numeric-string compare: "1000" vs "1000.00" and "0.9" vs "0.9000" are the
  // same value, not drift.
  if (a == null || b == null) return a == null && b == null;
  return Number(a) === Number(b);
}

async function checkOpportunities(): Promise<{
  checked: number;
  drift: DerivationDriftRow[];
}> {
  // One pass, set-based: all non-archived opps + one paid-sum GROUP BY + one
  // allocation scan, then the pure derivation per row in memory. No N+1, no
  // writes.
  const [opps, paidRows, allocRows] = await Promise.all([
    db
      .select({
        id: opportunitiesAndPledges.id,
        name: opportunitiesAndPledges.name,
        stage: opportunitiesAndPledges.stage,
        status: opportunitiesAndPledges.status,
        lossType: opportunitiesAndPledges.lossType,
        writtenPledge: opportunitiesAndPledges.writtenPledge,
        grantLetterUrl: opportunitiesAndPledges.grantLetterUrl,
        awardedAmount: opportunitiesAndPledges.awardedAmount,
        paid: opportunitiesAndPledges.paid,
        winProbability: opportunitiesAndPledges.winProbability,
      })
      .from(opportunitiesAndPledges)
      .where(isNull(opportunitiesAndPledges.archivedAt)),
    db
      .select({
        oppId: giftsAndPayments.opportunityId,
        paid: sql<string>`COALESCE(SUM(${giftsAndPayments.amount}), 0)::text`,
      })
      .from(giftsAndPayments)
      .where(
        and(
          isNotNull(giftsAndPayments.opportunityId),
          // Archived gifts are excluded from the paid rollup — same rule as
          // applyDerivedOppFields.
          isNull(giftsAndPayments.archivedAt),
        ),
      )
      .groupBy(giftsAndPayments.opportunityId),
    db
      .select({
        oppId: pledgeAllocations.pledgeOrOpportunityId,
        conditional: pledgeAllocations.conditional,
        conditionsMet: pledgeAllocations.conditionsMet,
      })
      .from(pledgeAllocations),
  ]);

  const paidByOpp = new Map<string, string>();
  for (const r of paidRows) {
    if (r.oppId) paidByOpp.set(r.oppId, r.paid);
  }
  const allocsByOpp = new Map<
    string,
    Array<{ conditional: string | null; conditionsMet: string | null }>
  >();
  for (const r of allocRows) {
    if (!r.oppId) continue;
    const list = allocsByOpp.get(r.oppId) ?? [];
    list.push({ conditional: r.conditional, conditionsMet: r.conditionsMet });
    allocsByOpp.set(r.oppId, list);
  }

  const drift: DerivationDriftRow[] = [];
  for (const row of opps) {
    const paid = paidByOpp.get(row.id) ?? "0";
    const rollup = rollupConditional(allocsByOpp.get(row.id) ?? []);
    const derived = deriveOppFields({
      stage: row.stage,
      lossType: row.lossType,
      writtenPledge: row.writtenPledge,
      conditional: rollup.conditional,
      grantLetterUrl: row.grantLetterUrl,
      awardedAmount: row.awardedAmount,
      paidAmount: paid,
    });

    const push = (field: string, stored: string | null, want: string | null) =>
      drift.push({
        table: "opportunities_and_pledges",
        id: row.id,
        name: row.name ?? null,
        field,
        stored,
        derived: want,
      });

    if (derived.status !== row.status) push("status", row.status, derived.status);
    if (derived.stage !== row.stage) push("stage", row.stage, derived.stage);
    // Treat a NULL stored flag as false — the applier would rewrite it, but it
    // is not semantic drift.
    if (derived.writtenPledge !== (row.writtenPledge ?? false)) {
      push(
        "written_pledge",
        row.writtenPledge == null ? null : String(row.writtenPledge),
        String(derived.writtenPledge),
      );
    }
    if (!numEq(row.paid ?? "0", paid)) push("paid", row.paid, paid);

    // win_probability: canonical is authoritative ONLY for pledge / cash_in /
    // lost / dormant. Open rows may carry a hand-set override — skip them.
    if (
      derived.status === "pledge" ||
      derived.status === "cash_in" ||
      derived.status === "lost" ||
      derived.status === "dormant"
    ) {
      const canonicalWp = canonicalWinProbability(
        derived.status,
        derived.stage,
        rollup.conditional,
      );
      if (canonicalWp !== null && !numEq(row.winProbability, canonicalWp)) {
        push("win_probability", row.winProbability, canonicalWp);
      }
    } else if (row.winProbability == null) {
      // Open rows may carry a hand-set override (skip value comparisons), but
      // NULL is never a legitimate override — the analytics rollups multiply
      // by win_probability with no fallback, so a NULL row silently drops out
      // of the weighted pipeline. Report it as drift.
      push(
        "win_probability",
        null,
        canonicalWinProbability(derived.status, derived.stage, rollup.conditional),
      );
    }
  }

  return { checked: opps.length, drift };
}

/** Run the full report-only health check. Safe against any DB (read-only). */
export async function runDerivationHealthCheck(): Promise<DerivationHealthReport> {
  const started = Date.now();
  const opps = await checkOpportunities();
  const all = opps.drift;
  const byField: Record<string, number> = {};
  for (const d of all) {
    byField[d.field] = (byField[d.field] ?? 0) + 1;
  }
  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checkedOpportunities: opps.checked,
    driftCount: all.length,
    byField,
    drift: all.slice(0, MAX_REPORT_ROWS),
    truncated: all.length > MAX_REPORT_ROWS,
  };
}
