# 0238 — Archive non-owner accounts

This migration archives the known demo users **Ben Reston** and **Carla
Santos**, the shared **Former Copper user** import placeholder, and the
canonical **Test Dev / Test Admin** E2E accounts. It never deletes or reassigns
records, so historical attribution remains intact.

From the repository root, with the production connection in
`$PROD_DATABASE_URL`:

```sh
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0238_archive_non_owner_accounts.sql
```

Verify that the known accounts are archived:

```sh
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
select id, email, display_name, archived_at
from users
where clerk_id in ('demo_ben', 'demo_carla')
   or lower(email) = 'former-copper-user@wildflowerschools.org'
   or (first_name ilike 'Test' and last_name in ('Dev', 'Admin'))
order by email;
"
```

Every returned row should have a non-null `archived_at`. The existing default
`GET /api/users` route filters on that field, so the rows disappear from every
owner picker after this migration without an application-code rollout.
