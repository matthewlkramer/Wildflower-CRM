# 0246 App feedback implementation brief storage

## Purpose

This migration replaces the verbose `proposal` JSON with the nullable
`implementation_brief` column on `app_feedback_proposals`. A ready proposal
must retain a non-empty brief; queued, generating, and error rows may remain
null. Feedback context snapshots, screenshots, reviewer guidance, revisions,
and implementation-request metadata are not changed.

## Read-only preflight

Run these queries before any migration action. They are safe for both
development and production before the migration:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT generation_status, count(*) AS row_count,
       count(*) FILTER (
         WHERE generation_status = 'ready'
           AND (proposal IS NULL
                OR jsonb_typeof(proposal -> 'implementationBrief') <> 'string'
                OR btrim(COALESCE(proposal ->> 'implementationBrief', '')) = '')
       ) AS ready_missing_or_empty_legacy_brief
FROM app_feedback_proposals
GROUP BY generation_status
ORDER BY generation_status;"

psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT generation_status, count(*) AS row_count,
       count(*) FILTER (
         WHERE generation_status = 'ready'
           AND (proposal IS NULL
                OR jsonb_typeof(proposal -> 'implementationBrief') <> 'string'
                OR btrim(COALESCE(proposal ->> 'implementationBrief', '')) = '')
       ) AS ready_missing_or_empty_legacy_brief
FROM app_feedback_proposals
GROUP BY generation_status
ORDER BY generation_status;"
```

Every ready row must have a zero finding before the migration can be applied.

## Human-run maintenance release and verification

This is a destructive representation swap: the prior server reads and writes
`proposal`, while the updated server reads and writes `implementation_brief`.
Do **not** apply it while an older application binary is serving requests, and
do **not** publish the updated binary before the column exists.

After a human reviews the preflight, production use requires an approved
maintenance release performed by a human:

1. Stop or drain all old application instances so no feedback generation,
   revision, or handoff request can use the legacy column.
2. Apply the migration from the repository root:

```sh
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0246_app_feedback_implementation_brief.sql
```

3. Publish and start only the updated application binary.
4. Run the postflight query below before reopening the feedback workflow.

The transaction adds the nullable column, copies only empty destinations from
the legacy JSON, verifies every ready row has a non-empty brief and every
copied ready brief exactly matches its source, then removes `proposal`. Any
failed check rolls back the whole transaction. This task did not apply this
procedure to production, publish, or deploy.

Afterward, verify the new representation:

```sh
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT generation_status, count(*) AS row_count,
       count(*) FILTER (
         WHERE generation_status = 'ready'
           AND (implementation_brief IS NULL
                OR btrim(implementation_brief) = '')
       ) AS ready_missing_or_empty_brief
FROM app_feedback_proposals
GROUP BY generation_status
ORDER BY generation_status;"
```
