# Runbook — 0009 media_mentions.dismissed (soft-delete tombstone)

## What this delivers

Makes "delete a media mention" durable. Instead of a hard `DELETE`, the API now
marks the row `dismissed = true`. The list endpoint hides dismissed rows and the
GDELT ingest upsert refuses to re-link or un-dismiss a dismissed URL, so a
deleted mention never comes back on the next news sync.

- Schema: `lib/db/src/schema/mediaMentions.ts` (`dismissed` boolean + index)
- API: `DELETE /media-mentions/:id` → UPDATE set dismissed; `GET /media-mentions`
  filters `dismissed = false`; `mediaIngest.upsertArticle` guards on
  `dismissed = false`.

Dismissal is **global per article (per url)** — hiding a mention hides it for
every entity it links to. A per-entity hide and an admin trash/undo UI are out
of scope (possible follow-ups).

## Order of operations

Run the migration **before or at the moment of** deploying the new app code. The
new code reads/writes the `dismissed` column; if code ships first, any
read/delete on `media_mentions` fails with `column "dismissed" does not exist`.

## Apply (production)

The agent cannot write to prod, and prod holds live data. A human applies:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0009_media_mention_dismissed.sql
```

The migration is additive + idempotent (`ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`). Re-running is a no-op. No backfill: existing rows
default to `dismissed = false` (still visible), so the migration hides nothing on
its own.

## Verify

```sql
SELECT count(*) FILTER (WHERE dismissed) AS dismissed_rows,
       count(*)                          AS total_rows
FROM media_mentions;  -- dismissed_rows = 0 immediately after migration
```

## Dev note

Dev already has this column applied additively (drizzle `push` was NOT used here
because the dev DB carries unrelated drift on `organizations` that a blunt push
would drop — see the cross-env-schema-drift convention). The column was added with
the same idempotent SQL above.
