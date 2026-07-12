// The original one-time Airtable importer (`lib/db/src/import-airtable.mjs`)
// has been retired and removed: it targeted the old split funders/organizations
// model and the CRM is now the system of record, so no re-import is planned.
// Git history preserves the script if it is ever needed again.
//
// This file is intentionally kept as a no-op so the `db seed` script in
// package.json still resolves without doing destructive work.

async function main() {
  console.log(
    "[seed] No-op: the CRM database is the system of record; the one-time Airtable importer was retired (see git history).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
