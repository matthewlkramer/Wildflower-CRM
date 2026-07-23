---
name: Prod-only DML migration rehearsal
description: How to validate a prod-only data migration when dev cannot host a live rehearsal (dev lacks the prod rows).
---

# Validating prod-only DML migrations without a live rehearsal

**Rule:** When a migration is keyed to prod-specific row ids that dev does not
have, a dev run proves nothing (preflight aborts) and a BEGIN/ROLLBACK dev run
dies on the first dev-data FK artifact. Instead, parse/plan-check every
statement against the real schema in read-only autocommit mode:

```bash
PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" \
  -f <(sed 's/RAISE EXCEPTION/RAISE WARNING/g' path/to/migration.sql) 2>&1 \
  | grep -v "cannot execute \(UPDATE\|INSERT\|DELETE\) in a read-only transaction"
```

**Why:** Postgres fully parses AND plans each DML statement (validating table
and column names, enum casts, ON CONFLICT targets) before rejecting the write
with the read-only error. Any remaining error is a real defect. Autocommit
(no `-1`, no ON_ERROR_STOP) keeps later statements checkable after earlier
rejections; the sed softens DO-block assertions so both DO blocks execute
their read-only SELECTs end to end.

**How to apply:** Use for every human-applied prod recoding file whose row
facts were gathered read-only from prod. Compensate for the missing live
rehearsal with (a) preflight DO assertions on the expected prod state,
(b) postflight DO invariants that RAISE and roll back the whole `psql -1`
transaction, and (c) a runbook caveat telling the applier a clean labeled
abort is a possible outcome, not a partial apply.
