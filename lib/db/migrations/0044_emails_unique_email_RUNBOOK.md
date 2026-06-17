# 0044 — Enforce globally-unique email addresses

## What this does

Makes an email address unique across the **entire** CRM (case-insensitive). No
address may be attached to more than one `emails` row — whether the owner is a
person, organization, payment intermediary, or household.

Two parts, in one transaction:

1. **Dedupe** any existing case-insensitive duplicate addresses. Within each
   `lower(email)` group it keeps the row flagged `is_preferred` (tie-break:
   earliest `created_at`, then `id`) and deletes the rest. The only foreign key
   to `emails.id` is `email_proposals.target_email_id`; any such reference on a
   deleted row is re-pointed to the kept row first.
2. **Add** `CREATE UNIQUE INDEX emails_email_lower_unique ON emails (lower(email))`.

`lower(email)` matches the normalization every read path already uses
(`emailIntelligence`, `proposeActions`, `flodeskSync`, `emailMatcher`, …).

## Why case-insensitive

The confirmed scope is "no email entered twice anywhere." Real data contained a
case-only duplicate (`SFisher@PIFgroup.com` vs `sfisher@pifgroup.com`), so the
constraint normalizes on `lower(email)` rather than the raw string.

## Known dev/prod duplicates removed (3 each, verified 2026-06-17)

Same address, same person, stored twice — no cross-person collisions:

- `ashley.beckner@gmail.com` — work + personal copy on one person
- `barb@acelero.net` — keeps the `is_preferred` synthetic copy
- `SFisher@PIFgroup.com` / `sfisher@pifgroup.com` — case-only difference

## Idempotency & safety

- **Idempotent**: after the first apply, no duplicates remain, the dedupe step
  selects nothing, and the index is `IF NOT EXISTS`. Re-running is a no-op.
- **Non-destructive** beyond the intended dedupe: it only removes surplus copies
  of an address that already exists on the same/another owner. No unrelated rows
  are touched.
- Wrapped in `BEGIN … COMMIT`; if the index creation were to fail (a duplicate
  slipped through), the whole transaction rolls back.

## Order of operations (IMPORTANT)

Run **this file first, then Publish.**

The Drizzle schema (`lib/db/src/schema/emails.ts`) declares the same index, so a
Publish will also try to add it. Creating it here first (idempotently) means
Publish's schema diff is a no-op for it, and — critically — it guarantees prod is
**dedup-free before any unique index is created**, so the index build cannot fail
on pre-existing duplicates.

## Apply (production)

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0044_emails_unique_email.sql
```

## Verify

```sql
-- Expect 0 rows (no remaining case-insensitive duplicates):
SELECT lower(email) AS addr, count(*)
FROM emails GROUP BY lower(email) HAVING count(*) > 1;

-- Expect the index to exist:
SELECT indexname FROM pg_indexes
WHERE tablename = 'emails' AND indexname = 'emails_email_lower_unique';
```

Already applied to **dev** via the same SQL on 2026-06-17.
