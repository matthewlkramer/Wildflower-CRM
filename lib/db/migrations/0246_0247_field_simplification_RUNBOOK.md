---
status: runbook
last_verified: 2026-09-12
---

# Field cleanup and newsletter evidence cutover (0246–0248)

Code and these migrations must be deployed together. A GitHub merge alone does
not deploy the Replit app. Follow `replit.md`'s production gate and reconcile
Replit-local work before bringing in the reviewed branch.

## Prepare and rehearse

1. Take a restorable database snapshot and preserve the original organization
   `id, org_email` values in an access-controlled export. Do not commit exports.
2. Rehearse on a disposable copy of the current database. Inspect all migration
   failures before proceeding. No address may be reassigned to another owner.
3. Before any automatic schema push, run this read-only preflight on the **old**
   schema. Resolve conflicts against source evidence; do not silently choose an
   owner or discard malformed text.

```sql
SELECT o.id, o.org_email,
  EXISTS (SELECT 1 FROM emails e
    WHERE lower(e.email) = lower(trim(o.org_email))
      AND e.organization_id IS DISTINCT FROM o.id) AS conflicting_contact_owner,
  EXISTS (SELECT 1 FROM organizations other WHERE other.id <> o.id
    AND lower(trim(other.org_email)) = lower(trim(o.org_email))) AS repeated_legacy_address
FROM organizations o
WHERE NULLIF(trim(o.org_email), '') IS NOT NULL
  AND (trim(o.org_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR EXISTS (SELECT 1 FROM emails e WHERE lower(e.email) = lower(trim(o.org_email))
      AND e.organization_id IS DISTINCT FROM o.id)
    OR EXISTS (SELECT 1 FROM organizations other WHERE other.id <> o.id
      AND lower(trim(other.org_email)) = lower(trim(o.org_email))));
```

Migration 0246 preserves every nonblank legacy address in canonical Emails and
the audit log, keeps existing preferred addresses, and only then drops
`org_email`. Any malformed address or conflicting ownership aborts the entire
transaction. It can be rerun after successful completion.

## Deploy during a controlled cutover

Pause application writes and background sync during the cutover. The old app
still queries `org_email`, so it cannot serve normally after 0246; the new app
needs 0247's history table and derivation trigger. Do not let a schema push drop
the old column before the preservation migration.

Run each reviewed file with stop-on-error and a transaction, using the intended
database URL from the deployment environment (never paste it into tickets):

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f lib/db/migrations/0247_newsletter_preference_history.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f lib/db/migrations/0246_canonical_organization_email.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f lib/db/migrations/0248_cleanup_research_projects.sql
```

Publish the reviewed code in Replit, then check organization email display/edit,
funding-region labels, person preference history, and both Cleanup Queue projects.
Keep sync paused until the source preview is reviewed. Resume it after checking
the resulting audience eligibility and suppression changes.

Migration 0247 captures old selected/unsubscribed flags as explicitly uncertain
historical evidence. It does not manufacture consent or historical event dates.
Migration 0248 only inserts the two requested shared projects, including the
worksheet link; it never overwrites team updates or reopens resolved work.

## Preview and apply source evidence

The deployment environment needs the existing Airtable and Flodesk credentials.
The operator must verify the selected database before running the command.
Preview is read-only against both providers and the CRM:

```sh
pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-newsletter-preferences.ts
```

`--production` explicitly selects `PROD_DATABASE_URL` before database imports.
Review the source counts, unmatched/conflicting source keys, and undated events.
Only exact email identities matched to one active CRM person are eligible for
import. Normalized SSJ rows take precedence over their raw duplicate, including
test/review dispositions. Provider pagination must finish before anything is
written. Unknown dates and initiators remain unknown.

For production, export a private, reviewable SQL snapshot rather than writing
from the importer. This preserves the human-applied production data-change
workflow:

```sh
pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-newsletter-preferences.ts --production --sql-output /secure/path/newsletter-evidence.sql
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f /secure/path/newsletter-evidence.sql
```

Store the reviewed artifact in the controlled migration workspace. It contains
constituent evidence: never commit it to GitHub or a public ticket. The export
refuses to overwrite an existing file, does not modify the CRM or providers, and
checks source-key conflicts and current email ownership again when applied. Any
conflict aborts the full transaction. It never sends email or creates people.
For a disposable development database, `--apply` runs the same reviewed import
through the shared evidence-writing service.

Repeat the preview after application; accepted events should now be counted as
already recorded. Preserve the aggregate report and unresolved source references
in the historical-newsletter cleanup project. Keep the project open until the
historical Flodesk and Mailchimp source review is complete.

## Recovery and verification

Before commit, migration failures roll back all changes in their transaction.
After publication, prefer a forward correction. Rolling back to code that reads
`org_email` requires restoring that column and its original values from the
snapshot/export; simply reverting the commit is insufficient. Keep the evidence
history when rolling back UI code, and do not enable old direct flag writers.

Verify that an ordinary profile edit cannot clear an opt-out; staff removal only
removes audience membership; old, same-time, and undated consent cannot lift
suppression; dated renewed consent can; merge preserves the full history. Confirm
primary organization email comes from Contact info and all original nonblank
values have migration audit entries. Check that the worksheet link opens from
Cleanup Queue and that resolving a project preserves it in the Resolved view.

Local rehearsal covered preservation, preferred-address retention, audit entries,
idempotent replay, malformed/conflicting rollback, and newsletter ordering/merge
invariants using synthetic data in PostgreSQL 18. Production-environment rehearsal
is still required before cutover.
