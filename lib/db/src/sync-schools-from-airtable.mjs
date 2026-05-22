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
//   - Upserts every record from the view by primary key (Airtable record ID).
//   - Does NOT delete schools that fall out of the source view. Instead, the
//     run logs which schools are now missing from the source view, including
//     how many gifts reference them, and the operator decides whether to
//     re-add them to the view or clean up refs and delete manually.
//   - Rationale: gifts_and_payments.school_recipient_id is ON DELETE RESTRICT
//     (money-trail data). A TRUNCATE-and-reload would either fail or silently
//     orphan gift history, both of which are worse than surfacing the diff.
//   - Safe to re-run.
//
// Requires AIRTABLE_TOKEN env var (the personal-access token from the Replit
// Airtable connector — `listConnections('airtable')[0].settings.access_token`).
// If unset, falls back to reading /tmp/airtable-dump/schools-base.json so this
// can also be driven from a pre-fetched dump.
import fs from "node:fs";
import pg from "pg";

const BASE_ID = "appJBT9a4f3b7hWQ2";
const TABLE_ID = "tblfdVLTc9ij4TaLh"; // Schools
const VIEW_ID = "viwfya5VZGmb7vu0s"; // Data for CRM in Replit
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
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
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
    (Array.isArray(f["Logo - main square"]) &&
      f["Logo - main square"][0]?.url) ||
    null;
  return [
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
    for (const rec of records) {
      await client.query(
        `INSERT INTO schools
           (id, name, long_name, short_name, status, governance_model,
            ages_planes, logo_main_square_url, stage_status,
            current_mailing_address, current_physical_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           long_name = EXCLUDED.long_name,
           short_name = EXCLUDED.short_name,
           status = EXCLUDED.status,
           governance_model = EXCLUDED.governance_model,
           ages_planes = EXCLUDED.ages_planes,
           logo_main_square_url = EXCLUDED.logo_main_square_url,
           stage_status = EXCLUDED.stage_status,
           current_mailing_address = EXCLUDED.current_mailing_address,
           current_physical_address = EXCLUDED.current_physical_address,
           updated_at = NOW()`,
        toRow(rec),
      );
    }
    // Detect stale schools (present in DB, absent from source view) and
    // report them with their gift-reference counts. Do NOT delete — the
    // RESTRICT FK from gifts_and_payments.school_recipient_id would block
    // it anyway, and silent SET NULL is not what we want for money-trail
    // data.
    const sourceIds = records.map((r) => r.id);
    const { rows: stale } = await client.query(
      `SELECT s.id, s.name,
              (SELECT COUNT(*)::int FROM gifts_and_payments
                 WHERE school_recipient_id = s.id) AS gift_refs,
              (SELECT COUNT(*)::int FROM gift_allocations
                 WHERE school_recipient_id = s.id) AS alloc_refs
         FROM schools s
        WHERE s.id <> ALL($1::text[])
        ORDER BY gift_refs DESC, s.name`,
      [sourceIds],
    );
    await client.query("COMMIT");
    if (stale.length) {
      console.warn(
        `\nNOTE: ${stale.length} school(s) are in the DB but missing from the source view ` +
          `(not deleted — review and clean up manually):`,
      );
      for (const s of stale) {
        console.warn(
          `  ${s.id}  ${s.name}  (gift refs: ${s.gift_refs}, allocation refs: ${s.alloc_refs})`,
        );
      }
      console.warn(
        `\nTo remove a stale school: clear gift/allocation refs ` +
          `(e.g. UPDATE gifts_and_payments SET school_recipient_id = NULL ...), ` +
          `then DELETE FROM schools WHERE id = '...'.`,
      );
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query("SELECT COUNT(*) FROM schools");
  console.log(`\nschools rowcount: ${rows[0].count}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
