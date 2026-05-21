// Seeding is now handled by `lib/db/src/import-airtable.mjs`, which imports
// the full "crm files" Airtable base (app8KUcmaHZ0AtcJZ) into Postgres.
//
// To re-import:
//   1. Dump Airtable data to /tmp/airtable-dump/*.json (one JSON file per
//      Airtable table; see the agent runbook in replit.md).
//   2. Run `node lib/db/src/import-airtable.mjs`.
//
// This file is intentionally kept as a no-op so the `db seed` script in
// package.json still resolves without doing destructive work.

async function main() {
  console.log(
    "[seed] No-op: schema is populated from Airtable via import-airtable.mjs",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
