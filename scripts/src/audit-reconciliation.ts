// Read-only audit of the reconciliation money spine and transition invariants.
//
// Usage:
//   DATABASE_URL="$PROD_DATABASE_URL" \
//     pnpm --filter @workspace/scripts run audit:reconciliation
//
// Optional:
//   --json             emit JSON only
//   --sample=25        number of record ids retained per finding (default 10)
//   --fail-on=high     exit non-zero for high/critical findings
//   --fail-on=critical exit non-zero only for critical findings
//
// This command never writes to the database and deliberately reports ids rather
// than donor names, emails, memos, or other potentially sensitive content.

import { pool } from "@workspace/db";

type Severity = "critical" | "high" | "medium" | "info";
type CheckStatus = "ok" | "finding" | "skipped" | "error";

type AuditFinding = {
  id: string;
  severity: Severity;
  summary: string;
  status: CheckStatus;
  count: number;
  sampleIds: string[];
  note?: string;
};

type AuditReport = {
  generatedAt: string;
  readOnly: true;
  findings: AuditFinding[];
  totals: Record<Severity, number>;
};

const args = new Set(process.argv.slice(2));
const jsonOnly = args.has("--json");
const sampleArg = [...args].find((arg) => arg.startsWith("--sample="));
const parsedSample = sampleArg
  ? Number(sampleArg.slice("--sample=".length))
  : 10;
const sampleLimit =
  Number.isInteger(parsedSample) && parsedSample > 0
    ? Math.min(parsedSample, 100)
    : 10;
const failArg = [...args].find((arg) => arg.startsWith("--fail-on="));
const failOn = failArg?.slice("--fail-on=".length) ?? "none";

async function relationExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [name],
  );
  return result.rows[0]?.exists === true;
}

async function runCheck(
  id: string,
  severity: Severity,
  summary: string,
  query: string,
  note?: string,
): Promise<AuditFinding> {
  try {
    const result = await pool.query<{
      count: number;
      sample_ids: string[] | null;
    }>(`
      SELECT
        count(*)::int AS count,
        COALESCE((array_agg(audit_row.id ORDER BY audit_row.id))[1:${sampleLimit}], ARRAY[]::text[]) AS sample_ids
      FROM (${query}) audit_row
    `);
    const count = result.rows[0]?.count ?? 0;
    return {
      id,
      severity,
      summary,
      status: count > 0 ? "finding" : "ok",
      count,
      sampleIds: result.rows[0]?.sample_ids ?? [],
      note,
    };
  } catch (error) {
    return {
      id,
      severity,
      summary,
      status: "error",
      count: 0,
      sampleIds: [],
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

function skipped(
  id: string,
  severity: Severity,
  summary: string,
  note: string,
): AuditFinding {
  return {
    id,
    severity,
    summary,
    status: "skipped",
    count: 0,
    sampleIds: [],
    note,
  };
}

function printHuman(report: AuditReport): void {
  console.log("Reconciliation audit (read only)");
  console.log(`Generated: ${report.generatedAt}`);
  console.log("");
  for (const finding of report.findings) {
    const marker =
      finding.status === "ok"
        ? "OK"
        : finding.status === "finding"
          ? "FINDING"
          : finding.status.toUpperCase();
    console.log(
      `[${marker}] ${finding.severity.toUpperCase()} ${finding.id}: ${finding.summary}`,
    );
    if (finding.status === "finding") {
      console.log(`  count: ${finding.count}`);
      if (finding.sampleIds.length > 0) {
        console.log(`  sample ids: ${finding.sampleIds.join(", ")}`);
      }
    }
    if (finding.note) console.log(`  note: ${finding.note}`);
  }
  console.log("");
  console.log("Finding totals:", report.totals);
}

function shouldFail(report: AuditReport): boolean {
  if (report.findings.some((finding) => finding.status === "error")) return true;
  if (failOn === "none") return false;
  const ranking: Record<Severity, number> = {
    info: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  const threshold = failOn === "critical" ? ranking.critical : ranking.high;
  return report.findings.some(
    (finding) =>
      finding.status === "finding" && ranking[finding.severity] >= threshold,
  );
}

async function main(): Promise<void> {
  const findings: AuditFinding[] = [];

  findings.push(
    await runCheck(
      "paired_payout_live_charge_missing_gift",
      "critical",
      "A bank-paired Stripe payout still has a live, non-excluded charge without a CRM gift tie.",
      `
      SELECT DISTINCT p.id
      FROM stripe_payouts p
      JOIN stripe_staged_charges ch ON ch.stripe_payout_id = p.id
      WHERE p.bank_deposit_id IS NOT NULL
        AND ch.raw_charge->>'status' = 'succeeded'
        AND ch.exclusion_reason IS NULL
        AND NOT ch.disputed
        AND NOT (
          ch.refunded = true
          AND COALESCE(ch.amount_refunded, 0) >= COALESCE(ch.gross_amount, 0) - 0.005
        )
        AND NOT EXISTS (
          SELECT 1
          FROM payment_units pu
          WHERE pu.stripe_charge_id = ch.id
            AND pu.gift_id IS NOT NULL
        )
    `,
      "These rows must remain active; a payout↔bank pairing is not end-to-end gift reconciliation.",
    ),
  );

  findings.push(
    await runCheck(
      "payment_unit_tie_metadata_without_gift",
      "high",
      "A payment unit has unit→gift tie metadata but no gift_id authority.",
      `
      SELECT pu.id
      FROM payment_units pu
      WHERE pu.gift_id IS NULL
        AND (
          pu.gift_allocation_id IS NOT NULL
          OR pu.gift_match_method IS NOT NULL
          OR pu.gift_confirmed_by_user_id IS NOT NULL
          OR pu.gift_confirmed_at IS NOT NULL
          OR pu.gift_note IS NOT NULL
          OR pu.created_the_gift = true
        )
    `,
    ),
  );

  findings.push(
    await runCheck(
      "payment_unit_allocation_wrong_gift",
      "critical",
      "A payment unit points to an allocation owned by a different gift.",
      `
      SELECT pu.id
      FROM payment_units pu
      JOIN gift_allocations ga ON ga.id = pu.gift_allocation_id
      WHERE pu.gift_id IS NULL OR ga.gift_id IS DISTINCT FROM pu.gift_id
    `,
    ),
  );

  findings.push(
    await runCheck(
      "duplicate_qbo_payment_units",
      "high",
      "One staged QuickBooks row is the source of more than one canonical payment unit.",
      `
      SELECT source_staged_payment_id AS id
      FROM payment_units
      WHERE source_staged_payment_id IS NOT NULL
      GROUP BY source_staged_payment_id
      HAVING count(*) > 1
    `,
    ),
  );

  findings.push(
    await runCheck(
      "component_qbo_provenance_disagrees_with_unit",
      "high",
      "A deposit component and its payment unit carry different QBO provenance pointers.",
      `
      SELECT c.id
      FROM bank_deposit_components c
      JOIN payment_units pu ON pu.id = c.payment_unit_id
      WHERE c.source_staged_payment_id IS NOT NULL
        AND pu.source_staged_payment_id IS NOT NULL
        AND c.source_staged_payment_id IS DISTINCT FROM pu.source_staged_payment_id
    `,
    ),
  );

  findings.push(
    await runCheck(
      "component_amount_differs_from_unit_without_review",
      "medium",
      "A non-review deposit component amount differs from its payment unit gross amount.",
      `
      SELECT c.id
      FROM bank_deposit_components c
      JOIN payment_units pu ON pu.id = c.payment_unit_id
      WHERE c.needs_review = false
        AND pu.gross_amount IS NOT NULL
        AND abs(c.amount - pu.gross_amount) >= 0.005
    `,
      "A legitimate difference should carry an explicit split/adjustment explanation rather than remain implicit.",
    ),
  );

  findings.push(
    await runCheck(
      "deposit_exclusion_with_open_money",
      "high",
      "A deposit-level exclusion coexists with an active component or Stripe charge.",
      `
      SELECT DISTINCT bde.bank_deposit_id AS id
      FROM bank_deposit_exclusions bde
      WHERE EXISTS (
        SELECT 1
        FROM bank_deposit_components c
        WHERE c.bank_deposit_id = bde.bank_deposit_id
          AND c.exclusion_reason IS NULL
      ) OR EXISTS (
        SELECT 1
        FROM stripe_payouts p
        JOIN stripe_staged_charges ch ON ch.stripe_payout_id = p.id
        WHERE p.bank_deposit_id = bde.bank_deposit_id
          AND ch.exclusion_reason IS NULL
      )
    `,
      "Deposit classification should normally derive from component/transaction dispositions; mixed states need review.",
    ),
  );

  findings.push(
    await runCheck(
      "live_stripe_charge_missing_payment_unit",
      "high",
      "A live, non-excluded Stripe charge has no canonical payment unit.",
      `
      SELECT ch.id
      FROM stripe_staged_charges ch
      WHERE ch.raw_charge->>'status' = 'succeeded'
        AND ch.exclusion_reason IS NULL
        AND NOT ch.disputed
        AND NOT (
          ch.refunded = true
          AND COALESCE(ch.amount_refunded, 0) >= COALESCE(ch.gross_amount, 0) - 0.005
        )
        AND NOT EXISTS (
          SELECT 1 FROM payment_units pu WHERE pu.stripe_charge_id = ch.id
        )
    `,
      "This usually indicates the best-effort bank-spine recompute has fallen behind source ingestion.",
    ),
  );

  findings.push(
    await runCheck(
      "stripe_unit_source_fact_drift",
      "medium",
      "A Stripe payment unit's amount or lifecycle differs from its source charge.",
      `
      SELECT pu.id
      FROM payment_units pu
      JOIN stripe_staged_charges ch ON ch.id = pu.stripe_charge_id
      WHERE pu.gross_amount IS DISTINCT FROM ch.gross_amount
         OR pu.fee_amount IS DISTINCT FROM ch.fee_amount
         OR pu.net_amount IS DISTINCT FROM ch.net_amount
         OR pu.lifecycle IS DISTINCT FROM (
           CASE
             WHEN ch.disputed THEN 'disputed'
             WHEN ch.refunded THEN 'refunded'
             WHEN ch.amount_refunded IS NOT NULL AND ch.amount_refunded > 0 THEN 'partially_refunded'
             ELSE 'received'
           END::payment_unit_lifecycle
         )
    `,
    ),
  );

  findings.push(
    await runCheck(
      "qbo_unit_source_fact_drift",
      "medium",
      "A QBO-derived payment unit's amount, date, or currency differs from its staged source row.",
      `
      SELECT pu.id
      FROM payment_units pu
      JOIN staged_payments sp ON sp.id = pu.source_staged_payment_id
      WHERE pu.stripe_charge_id IS NULL
        AND (
          pu.gross_amount IS DISTINCT FROM sp.amount
          OR pu.received_date IS DISTINCT FROM sp.date_received
          OR upper(pu.currency) IS DISTINCT FROM upper(COALESCE(sp.qb_currency, 'USD'))
        )
    `,
    ),
  );

  findings.push(
    await runCheck(
      "redundant_qbo_line_and_component_claim",
      "info",
      "The same staged QBO row appears as both deposit-line evidence and a component's unit provenance.",
      `
      SELECT sl.id
      FROM source_links sl
      JOIN payment_units pu ON pu.source_staged_payment_id = sl.qb_staged_payment_id
      JOIN bank_deposit_components c
        ON c.payment_unit_id = pu.id
       AND c.bank_deposit_id = sl.bank_deposit_id
      WHERE sl.link_type = 'qbo_line_deposit'
    `,
      "The UI now suppresses the duplicate card, but this count shows how much redundant provenance remains in the data model.",
    ),
  );

  if (await relationExists("payment_applications")) {
    findings.push(
      await runCheck(
        "payment_applications_counted_pointer_disagreement",
        "critical",
        "A counted payment_applications row disagrees with payment_units.gift_id.",
        `
        SELECT pa.id
        FROM payment_applications pa
        JOIN payment_units pu ON pu.id = pa.payment_unit_id
        WHERE pa.link_role = 'counted'
          AND pu.gift_id IS DISTINCT FROM pa.gift_id
      `,
      ),
    );

    findings.push(
      await runCheck(
        "payment_unit_pointer_without_counted_application",
        "info",
        "A tied payment unit has no counted payment_applications predecessor row.",
        `
        SELECT pu.id
        FROM payment_units pu
        WHERE pu.gift_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM payment_applications pa
            WHERE pa.payment_unit_id = pu.id
              AND pa.link_role = 'counted'
              AND pa.gift_id = pu.gift_id
          )
      `,
        "Expected after the pointer write cutover; use this inventory when deciding whether the retired table can be dropped.",
      ),
    );
  } else {
    findings.push(
      skipped(
        "payment_applications_parity",
        "info",
        "Compare the retired payment_applications ledger with payment_units.gift_id.",
        "payment_applications is already absent.",
      ),
    );
  }

  if (await relationExists("unit_groups")) {
    findings.push(
      await runCheck(
        "legacy_unit_groups_remaining",
        "info",
        "Legacy unit-group rows remain after group semantics were retired.",
        "SELECT id FROM unit_groups",
        "Verify every member is represented by canonical payment-unit ties before applying the gated retirement migration.",
      ),
    );
  } else {
    findings.push(
      skipped(
        "legacy_unit_groups_remaining",
        "info",
        "Legacy unit-group rows remain after group semantics were retired.",
        "unit_groups is already absent.",
      ),
    );
  }

  const totals: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    info: 0,
  };
  for (const finding of findings) {
    if (finding.status === "finding") totals[finding.severity] += finding.count;
  }

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    findings,
    totals,
  };

  if (jsonOnly) console.log(JSON.stringify(report, null, 2));
  else {
    printHuman(report);
    console.log("");
    console.log("JSON report:");
    console.log(JSON.stringify(report, null, 2));
  }

  if (shouldFail(report)) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error("reconciliation audit failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
