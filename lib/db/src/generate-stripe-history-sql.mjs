// Generate an idempotent SQL backfill of the historical Stripe balance-history
// export into stripe_payouts + stripe_staged_charges.
//
// The CSV is a full Stripe "Balance history" export for the PRIOR Stripe account
// (acct_1DF6BFAhXr9x8yiR — proven by the AhXr9x8yiR id infix carried by every
// row). The live API sync uses a DIFFERENT connector account, so this data can
// only ever be loaded from the export — it is exactly the historical
// back-catalogue the ongoing (watermark-based) sync intentionally skips.
//
// The emitted SQL mirrors stripeSync.ts semantics:
//   * payout rollups follow rollupPayout (gross = Σ charge/payment, refund =
//     Σ|refund|, fee = Σ all txns' fees, net = gross − fee − refund), while the
//     authoritative `amount` (bank net) comes from the payout row's own Net.
//   * date_received is the charge time converted to America/Chicago (chargeDateReceived).
//   * charges are staged status='pending', match_status='unmatched', NO donor FKs
//     (donor matching is environment-specific; the reconciliation queue / a later
//     matcher run resolves donors per-env — keeps this file safe for dev AND prod).
//
// Idempotent: keyed on the Stripe id PKs with ON CONFLICT (id) DO NOTHING, so a
// re-run (or a row the ongoing sync already pulled) is preserved untouched.
//
//   node lib/db/src/generate-stripe-history-sql.mjs [input.csv] [output.sql]

import { readFileSync, writeFileSync } from "node:fs";

const INPUT =
  process.argv[2] ?? "attached_assets/balance_history_1781913987279.csv";
const OUTPUT =
  process.argv[3] ?? "lib/db/migrations/0055_stripe_history_backfill.sql";
const ACCOUNT_ID = "acct_1DF6BFAhXr9x8yiR";

// ── RFC4180 CSV parser (handles quotes, "" escapes, embedded commas/newlines) ──
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore; \n handles the line break
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── SQL literal helpers ───────────────────────────────────────────────────
const NULL = "NULL";
function s(v) {
  if (v == null || v === "") return NULL;
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function n(v) {
  if (v == null || v === "") return NULL;
  const f = Number.parseFloat(v);
  if (Number.isNaN(f)) return NULL;
  return f.toFixed(2);
}
function jsonb(obj) {
  if (!obj || Object.keys(obj).length === 0) return NULL;
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}

// "YYYY-MM-DD HH:MM[:SS]" (UTC) -> timestamptz literal.
function utcTs(v) {
  if (!v) return NULL;
  const t = v.trim();
  const withSecs = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(t)
    ? t
    : `${t}:00`;
  return `'${withSecs}+00'`;
}
// First 10 chars -> "YYYY-MM-DD" date literal.
function dateLit(v) {
  if (!v) return NULL;
  return `'${v.trim().slice(0, 10)}'`;
}
// Stripe charge time (UTC) -> America/Chicago calendar date (chargeDateReceived).
const CHICAGO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function chicagoDate(v) {
  if (!v) return NULL;
  const d = new Date(`${v.trim().replace(" ", "T")}:00Z`);
  if (Number.isNaN(d.getTime())) return NULL;
  return `'${CHICAGO.format(d)}'`;
}
function emailFromDescription(desc) {
  if (!desc) return null;
  const m = desc.match(/from\s+([^\s,;]+@[^\s,;]+)/i);
  return m ? m[1] : null;
}

// ── Parse ─────────────────────────────────────────────────────────────────
const grid = parseCsv(readFileSync(INPUT, "utf8"));
const header = grid[0];
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const col = (r, name) => r[idx[name]] ?? "";
const metaKeys = header
  .filter((h) => h.endsWith(" (metadata)"))
  .map((h) => ({ header: h, key: h.replace(/ \(metadata\)$/, "") }));

function assert(cond, msg) {
  if (!cond) throw new Error(`generate-stripe-history-sql: ${msg}`);
}

// Guard: the CSV must be the expected export shape and the expected account.
const REQUIRED_HEADERS = [
  "id",
  "Type",
  "Source",
  "Amount",
  "Fee",
  "Net",
  "Currency",
  "Created (UTC)",
  "Transfer",
  "Transfer Date (UTC)",
];
for (const h of REQUIRED_HEADERS) {
  assert(idx[h] != null, `missing required CSV column "${h}"`);
}
// Every Stripe id carries the account's infix (last 10 chars of the acct id).
const ACCT_INFIX = ACCOUNT_ID.slice(-10);

const rows = grid
  .slice(1)
  .filter((r) => r.length > 1 && r[idx["id"]])
  .map((r) => ({
    id: col(r, "id"),
    type: col(r, "Type"),
    source: col(r, "Source"),
    amount: col(r, "Amount"),
    fee: col(r, "Fee"),
    net: col(r, "Net"),
    currency: col(r, "Currency"),
    created: col(r, "Created (UTC)"),
    availableOn: col(r, "Available On (UTC)"),
    description: col(r, "Description"),
    transfer: col(r, "Transfer"),
    transferDate: col(r, "Transfer Date (UTC)"),
    meta: Object.fromEntries(
      metaKeys
        .map(({ header: h, key }) => [key, (r[idx[h]] ?? "").trim()])
        .filter(([, v]) => v !== ""),
    ),
  }));

const CHARGE_TYPES = new Set(["charge", "payment"]);
const REFUND_TYPES = new Set(["refund", "payment_refund"]);

// Failed payouts (a payout_failure row's Source is the payout that failed).
const failedPayouts = new Set(
  rows.filter((r) => r.type === "payout_failure").map((r) => r.source),
);

// amount_refunded per charge source (refund + payment_failure_refund rows).
const refundedBySource = new Map();
for (const r of rows) {
  if (r.type === "refund" || r.type === "payment_failure_refund") {
    const prev = refundedBySource.get(r.source) ?? 0;
    refundedBySource.set(r.source, prev + Math.abs(Number.parseFloat(r.amount) || 0));
  }
}

// Group all non-payout balance txns under the payout (Transfer) they settled in.
const groupByPayout = new Map();
for (const r of rows) {
  if (r.type === "payout" || !r.transfer) continue;
  if (!groupByPayout.has(r.transfer)) groupByPayout.set(r.transfer, []);
  groupByPayout.get(r.transfer).push(r);
}

// ── Build payout rows ───────────────────────────────────────────────────────
const payoutRows = rows.filter((r) => r.type === "payout");
const payouts = payoutRows
  .map((p) => {
    const po = p.source;
    const group = groupByPayout.get(po) ?? [];
    let gross = 0;
    let feeMinor = 0;
    let refund = 0;
    let count = 0;
    for (const g of group) {
      feeMinor += Number.parseFloat(g.fee) || 0;
      if (CHARGE_TYPES.has(g.type)) {
        gross += Number.parseFloat(g.amount) || 0;
        count += 1;
      } else if (REFUND_TYPES.has(g.type)) {
        refund += Math.abs(Number.parseFloat(g.amount) || 0);
      }
    }
    const net = gross - feeMinor - refund;
    const amount = Math.abs(Number.parseFloat(p.net) || 0);
    return {
      id: po,
      amount: amount.toFixed(2),
      currency: (p.currency || "usd").toLowerCase(),
      status: failedPayouts.has(po) ? "failed" : "paid",
      arrivalDate: p.transferDate || p.availableOn || p.created,
      payoutCreated: p.created,
      grossTotal: gross.toFixed(2),
      feeTotal: feeMinor.toFixed(2),
      refundTotal: refund.toFixed(2),
      netTotal: net.toFixed(2),
      chargeCount: count,
    };
  })
  .sort((a, b) => (a.id < b.id ? -1 : 1));

// ── Build staged-charge rows ────────────────────────────────────────────────
const charges = rows
  .filter((r) => CHARGE_TYPES.has(r.type))
  .map((c) => {
    const gross = Number.parseFloat(c.amount) || 0;
    const refunded = refundedBySource.get(c.source) ?? 0;
    return {
      id: c.source,
      payoutId: c.transfer || null,
      btId: c.id,
      gross: gross.toFixed(2),
      fee: c.fee,
      net: c.net,
      amountRefunded: refunded.toFixed(2),
      currency: (c.currency || "usd").toLowerCase(),
      created: c.created,
      payerName: c.meta["donorbox_name"] || null,
      payerEmail: c.meta["donorbox_email"] || emailFromDescription(c.description) || null,
      description: c.description || null,
      metadata: c.meta,
      refunded: refunded > 0 && refunded + 0.005 >= gross,
    };
  })
  .sort((a, b) => (a.id < b.id ? -1 : 1));

// ── Validate before emitting (hard-fail; protects against a wrong/changed CSV) ─
const payoutIds = new Set();
for (const p of payouts) {
  assert(!payoutIds.has(p.id), `duplicate payout id ${p.id}`);
  payoutIds.add(p.id);
  assert(p.id.includes(ACCT_INFIX), `payout id ${p.id} missing account infix ${ACCT_INFIX}`);
}
const chargeIds = new Set();
for (const c of charges) {
  assert(!chargeIds.has(c.id), `duplicate charge id ${c.id}`);
  chargeIds.add(c.id);
  assert(c.id.includes(ACCT_INFIX), `charge id ${c.id} missing account infix ${ACCT_INFIX}`);
  // A non-null payout reference MUST resolve to a payout row, else the FK fails.
  assert(
    !c.payoutId || payoutIds.has(c.payoutId),
    `charge ${c.id} references payout ${c.payoutId} not present in the export`,
  );
}

// ── Emit SQL ────────────────────────────────────────────────────────────────
const out = [];
out.push(`-- Migration 0055: backfill historical Stripe balance-history export`);
out.push(`--`);
out.push(`-- Loads a full Stripe "Balance history" CSV export for the PRIOR Stripe`);
out.push(`-- account ${ACCOUNT_ID} (every exported id carries that account's`);
out.push(`-- AhXr9x8yiR infix) into stripe_payouts + stripe_staged_charges. The live`);
out.push(`-- API sync runs against a DIFFERENT connector account and is ongoing-only`);
out.push(`-- (watermarked), so this historical back-catalogue can only be loaded here.`);
out.push(`--`);
out.push(`-- Rows: ${payouts.length} payouts, ${charges.length} staged charges`);
out.push(`-- Source: ${INPUT}`);
out.push(`--`);
out.push(`-- Payout rollups mirror rollupPayout() (gross = Σ charge/payment, refund =`);
out.push(`-- Σ|refund|, fee = Σ all fees, net = gross − fee − refund); the bank-net`);
out.push(`-- \`amount\` comes from each payout row's own Net. Charge date_received is the`);
out.push(`-- charge time in America/Chicago (chargeDateReceived).`);
out.push(`--`);
out.push(`-- Charges are staged status='pending', match_status='unmatched', with NO`);
out.push(`-- donor FKs: donor identity is environment-specific, so matching is left to`);
out.push(`-- the reconciliation queue / a later matcher run in each environment. This`);
out.push(`-- keeps the file identical + safe for dev AND prod.`);
out.push(`--`);
out.push(`-- SAFETY / IDEMPOTENCY:`);
out.push(`--   * Purely additive. ON CONFLICT (id) DO NOTHING — re-runs are a no-op and`);
out.push(`--     any row the ongoing sync already pulled is left untouched.`);
out.push(`--   * Payouts are inserted before charges so the stripe_payout_id FK holds.`);
out.push(`--   * No donor / gift / intermediary FKs are written, so this does NOT depend`);
out.push(`--     on the pending schema Publish (the stripe_* tables already exist in prod).`);
out.push(`--`);
out.push(`--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0055_stripe_history_backfill.sql`);
out.push("");

// Payouts
out.push(
  `INSERT INTO stripe_payouts (id, stripe_account_id, amount, currency, status, automatic, arrival_date, payout_created, gross_total, fee_total, refund_total, net_total, charge_count) VALUES`,
);
out.push(
  payouts
    .map(
      (p) =>
        `  (${s(p.id)}, ${s(ACCOUNT_ID)}, ${p.amount}, ${s(p.currency)}, ${s(p.status)}, ${NULL}, ${dateLit(p.arrivalDate)}, ${utcTs(p.payoutCreated)}, ${p.grossTotal}, ${p.feeTotal}, ${p.refundTotal}, ${p.netTotal}, ${p.chargeCount})`,
    )
    .join(",\n"),
);
out.push(`ON CONFLICT (id) DO NOTHING;`);
out.push("");

// Staged charges
out.push(
  `INSERT INTO stripe_staged_charges (id, stripe_account_id, stripe_payout_id, stripe_balance_transaction_id, gross_amount, fee_amount, net_amount, amount_refunded, currency, charge_created, date_received, payer_name, payer_email, description, metadata, refunded, disputed, status, classification_source, match_status, auto_applied) VALUES`,
);
out.push(
  charges
    .map(
      (c) =>
        `  (${s(c.id)}, ${s(ACCOUNT_ID)}, ${c.payoutId ? s(c.payoutId) : NULL}, ${s(c.btId)}, ${n(c.gross)}, ${n(c.fee)}, ${n(c.net)}, ${c.amountRefunded}, ${s(c.currency)}, ${utcTs(c.created)}, ${chicagoDate(c.created)}, ${s(c.payerName)}, ${s(c.payerEmail)}, ${s(c.description)}, ${jsonb(c.metadata)}, ${c.refunded}, false, 'pending', 'auto', 'unmatched', false)`,
    )
    .join(",\n"),
);
out.push(`ON CONFLICT (id) DO NOTHING;`);
out.push("");

writeFileSync(OUTPUT, out.join("\n"));
console.log(
  `Wrote ${OUTPUT}: ${payouts.length} payouts, ${charges.length} charges`,
);
const totalGross = charges.reduce((a, c) => a + Number.parseFloat(c.gross), 0);
const linked = charges.filter((c) => c.payoutId).length;
console.log(
  `  charges linked to a payout: ${linked}/${charges.length}; Σ gross = $${totalGross.toFixed(2)}`,
);
console.log(`  payouts status=failed: ${payouts.filter((p) => p.status === "failed").length}`);
