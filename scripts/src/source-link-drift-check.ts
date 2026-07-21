/**
 * source_links drift check — verifies the deprecated pointer columns (dual-write
 * mirrors) agree with the authoritative `source_links` ledger
 * (docs/adr-source-link-ledger.md). Read-only; exits 1 on any drift.
 *
 * Pointer ↔ ledger pairs checked (both directions):
 *   stripe_staged_charges.linked_qb_staged_payment_id     ↔ charge_qb_tie (confirmed)
 *   stripe_staged_charges.proposed_qb_staged_payment_id   ↔ charge_qb_tie (proposed)
 *   stripe_staged_charges.linked_fee_qb_staged_payment_id ↔ charge_fee_row
 *   donorbox_donations.linked_qb_staged_payment_id        ↔ donorbox_qb
 *   donorbox_donations.linked_stripe_charge_id            ↔ donorbox_charge
 *
 * Run: pnpm --filter @workspace/scripts run check:source-link-drift
 */
import { pool } from "@workspace/db";

interface DriftCheck {
  name: string;
  query: string;
}

const checks: DriftCheck[] = [
  {
    name: "charge tie (confirmed): pointer set, ledger row missing/mismatched",
    query: `
      SELECT c.id FROM stripe_staged_charges c
      WHERE c.linked_qb_staged_payment_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'charge_qb_tie'
            AND sl.lifecycle = 'confirmed'
            AND sl.stripe_charge_id = c.id
            AND sl.qb_staged_payment_id = c.linked_qb_staged_payment_id
        )`,
  },
  {
    name: "charge tie (confirmed): ledger row present, pointer missing/mismatched",
    query: `
      SELECT sl.id FROM source_links sl
      JOIN stripe_staged_charges c ON c.id = sl.stripe_charge_id
      WHERE sl.link_type = 'charge_qb_tie'
        AND sl.lifecycle = 'confirmed'
        AND c.linked_qb_staged_payment_id IS DISTINCT FROM sl.qb_staged_payment_id`,
  },
  {
    name: "charge tie (proposed): pointer set, ledger row missing/mismatched",
    query: `
      SELECT c.id FROM stripe_staged_charges c
      WHERE c.proposed_qb_staged_payment_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'charge_qb_tie'
            AND sl.lifecycle = 'proposed'
            AND sl.stripe_charge_id = c.id
            AND sl.qb_staged_payment_id = c.proposed_qb_staged_payment_id
        )`,
  },
  {
    name: "charge tie (proposed): ledger row present, pointer missing/mismatched",
    query: `
      SELECT sl.id FROM source_links sl
      JOIN stripe_staged_charges c ON c.id = sl.stripe_charge_id
      WHERE sl.link_type = 'charge_qb_tie'
        AND sl.lifecycle = 'proposed'
        AND c.proposed_qb_staged_payment_id IS DISTINCT FROM sl.qb_staged_payment_id`,
  },
  {
    name: "charge fee row: pointer set, ledger row missing/mismatched",
    query: `
      SELECT c.id FROM stripe_staged_charges c
      WHERE c.linked_fee_qb_staged_payment_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'charge_fee_row'
            AND sl.stripe_charge_id = c.id
            AND sl.qb_staged_payment_id = c.linked_fee_qb_staged_payment_id
        )`,
  },
  {
    name: "charge fee row: ledger row present, pointer missing/mismatched",
    query: `
      SELECT sl.id FROM source_links sl
      JOIN stripe_staged_charges c ON c.id = sl.stripe_charge_id
      WHERE sl.link_type = 'charge_fee_row'
        AND c.linked_fee_qb_staged_payment_id IS DISTINCT FROM sl.qb_staged_payment_id`,
  },
  {
    name: "donorbox↔QB: pointer set, ledger row missing/mismatched",
    query: `
      SELECT d.id FROM donorbox_donations d
      WHERE d.linked_qb_staged_payment_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'donorbox_qb'
            AND sl.donorbox_donation_id = d.id
            AND sl.qb_staged_payment_id = d.linked_qb_staged_payment_id
        )`,
  },
  {
    name: "donorbox↔QB: ledger row present, pointer missing/mismatched",
    query: `
      SELECT sl.id FROM source_links sl
      JOIN donorbox_donations d ON d.id = sl.donorbox_donation_id
      WHERE sl.link_type = 'donorbox_qb'
        AND d.linked_qb_staged_payment_id IS DISTINCT FROM sl.qb_staged_payment_id`,
  },
  {
    name: "donorbox↔charge: pointer set, ledger row missing/mismatched",
    query: `
      SELECT d.id FROM donorbox_donations d
      WHERE d.linked_stripe_charge_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM source_links sl
          WHERE sl.link_type = 'donorbox_charge'
            AND sl.donorbox_donation_id = d.id
            AND sl.stripe_charge_id = d.linked_stripe_charge_id
        )`,
  },
  {
    name: "donorbox↔charge: ledger row present, pointer missing/mismatched",
    query: `
      SELECT sl.id FROM source_links sl
      JOIN donorbox_donations d ON d.id = sl.donorbox_donation_id
      WHERE sl.link_type = 'donorbox_charge'
        AND d.linked_stripe_charge_id IS DISTINCT FROM sl.stripe_charge_id`,
  },
];

async function main(): Promise<void> {
  let drift = 0;
  for (const check of checks) {
    const result = await pool.query<{ id: string }>(check.query);
    if (result.rows.length > 0) {
      drift += result.rows.length;
      const sample = result.rows.slice(0, 10).map((r) => r.id);
      console.error(
        `DRIFT (${result.rows.length}): ${check.name}\n  sample ids: ${sample.join(", ")}`,
      );
    } else {
      console.log(`ok: ${check.name}`);
    }
  }
  if (drift > 0) {
    console.error(
      `\n${drift} drifted row(s) — pointer mirrors disagree with source_links.`,
    );
    process.exitCode = 1;
  } else {
    console.log("\nNo drift: pointer mirrors and source_links agree.");
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
