/**
 * Derivation health check — REPORT-ONLY, never writes.
 *
 * Re-derives every persisted-derived field (opportunity status / stage /
 * written_pledge / paid / win_probability) through the same pure functions the
 * write-path appliers use, and reports any row where stored ≠ derived.
 * NOTE: quickbooks_tie_status is now LIVE-DERIVED (never persisted, Task #451)
 * and is no longer checked. Exit code 0 = clean, 1 = drift found, 2 = crashed.
 *
 * Safe to run against PRODUCTION (read-only):
 *   DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/api-server run health:derivations
 *
 * Dev: pnpm --filter @workspace/api-server run health:derivations
 */
import { runDerivationHealthCheck } from "../lib/derivationHealth";

async function main(): Promise<void> {
  const report = await runDerivationHealthCheck();
  console.log(
    `Checked ${report.checkedOpportunities} opportunities in ${report.durationMs}ms.`,
  );
  if (report.driftCount === 0) {
    console.log("No drift — every stored derived field matches its derivation.");
    return;
  }
  console.log(`DRIFT: ${report.driftCount} field(s) where stored ≠ derived:`);
  for (const [field, n] of Object.entries(report.byField)) {
    console.log(`  ${field}: ${n}`);
  }
  console.log("");
  for (const d of report.drift) {
    console.log(
      `  [${d.table}] ${d.id}  ${d.field}: stored=${d.stored ?? "NULL"} → derived=${d.derived ?? "NULL"}  (${d.name ?? "unnamed"})`,
    );
  }
  if (report.truncated) {
    console.log(`  … truncated (showing ${report.drift.length} of ${report.driftCount})`);
  }
  process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("Derivation health check failed to run:", err);
    process.exit(2);
  });
