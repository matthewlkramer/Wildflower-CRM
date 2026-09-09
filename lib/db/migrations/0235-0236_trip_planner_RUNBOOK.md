# 0235–0236 — Trip planner production rollout

These two migrations are additive and idempotent. They must be applied in order
before publishing code that reads or writes trips. Publishing application code
does not create the tables automatically.

From the repository root, with the production connection in
`$PROD_DATABASE_URL`:

```sh
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0235_trip_planner.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0236_trip_window_calendar_details.sql
```

Verify the required tables and calendar columns before publishing:

```sh
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select to_regclass('public.trip_plans') as trip_plans, to_regclass('public.trip_visit_candidates') as trip_visit_candidates;"
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'calendar_events' and column_name in ('transparency', 'google_visibility') order by column_name;"
```

Expected: both table names are non-null and both calendar column names are
returned. Stop the release if any result is missing.
