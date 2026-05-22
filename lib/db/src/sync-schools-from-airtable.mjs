// Pulls the Schools table from the dedicated Wildflower Schools Airtable base
// ("appJBT9a4f3b7hWQ2") into our `schools` Postgres table.
//
// One-way: Airtable is the source of truth, we just mirror the columns visible
// in the "Data for CRM in Replit" view (viwfya5VZGmb7vu0s):
//   Name, Long Name, Short Name, School Status, Governance Model, Ages-Planes,
//   Logo - main square, Stage_Status, Current Mailing Address,
//   Current Physical Address.
//
// Behaviour:
//   - Wipes the `schools` table and re-inserts every record from the view.
//   - Uses each Airtable record ID as the Postgres primary key.
//   - Safe to re-run (idempotent through TRUNCATE).
//
// Requires AIRTABLE_TOKEN env var (the personal-access token from the Replit
// Airtable connector — `listConnections('airtable')[0].settings.access_token`).
// If unset, falls back to reading /tmp/airtable-dump/schools-base.json so this
// can also be driven from a pre-fetched dump.
import fs from "node:fs";
import pg from "pg";

const BASE_ID = "appJBT9a4f3b7hWQ2";
const TABLE_ID = "tblfdVLTc9ij4TaLh"; // Schools
const VIEW_ID = "viwfya5VZGmb7vu0s";  // Data for CRM in Replit
const DUMP_PATH = "/tmp/airtable-dump/schools-base.json";

const STATUS_MAP = {
  Emerging: "emerging",
  Open: "open",
  Paused: "paused",
  Closing: "closing",
  "Permanently Closed": "permanently_closed",
  Disaffiliating: "disaffiliating",
  Disaffiliated: "disaffiliated",
  Placeholder: "placeholder",
  Abandoned: "abandoned",
};

const GOV_MAP = {
  Independent: "independent",
  District: "district",
  Charter: "charter",
  "Exploring Charter": "exploring_charter",
  "Community Partnership": "community_partnership",
};

async function fetchAllRecords(token) {
  const out = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
    url.searchParams.set("view", VIEW_ID);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}

function loadRecords() {
  const token = process.env.AIRTABLE_TOKEN;
  if (token) return fetchAllRecords(token);
  if (fs.existsSync(DUMP_PATH)) {
    console.log(`AIRTABLE_TOKEN not set; reading ${DUMP_PATH}`);
    return Promise.resolve(JSON.parse(fs.readFileSync(DUMP_PATH, "utf8")));
  }
  throw new Error(
    "Set AIRTABLE_TOKEN (from the Replit Airtable connector) or " +
      `pre-fetch records to ${DUMP_PATH}.`,
  );
}

const joinLookup = (v) =>
  Array.isArray(v) ? v.filter(Boolean).join("\n\n") || null : (v ?? null);

function toRow(rec) {
  const f = rec.fields;
  const logo =
    (Array.isArray(f["Logo - main square"]) && f["Logo - main square"][0]?.url) ||
    null;
  return [
    rec.id,
    rec.id,
    f["Name"] || "(unnamed)",
    f["Long Name"] || null,
    f["Short Name"] || null,
    STATUS_MAP[f["School Status"]] || null,
    GOV_MAP[f["Governance Model"]] || null,
    Array.isArray(f["Ages-Planes"]) ? f["Ages-Planes"] : null,
    logo,
    f["Stage_Status"] || null,
    joinLookup(f["Current Mailing Address"]),
    joinLookup(f["Current Physical Address"]),
  ];
}

async function main() {
  const records = await loadRecords();
  console.log(`Fetched ${records.length} schools.`);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE schools");
    for (const rec of records) {
      await client.query(
        `INSERT INTO schools
           (id, airtable_id, name, long_name, short_name, status, governance_model,
            ages_planes, logo_main_square_url, stage_status,
            current_mailing_address, current_physical_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        toRow(rec),
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query("SELECT COUNT(*) FROM schools");
  console.log(`schools rowcount: ${rows[0].count}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
