# Runbook — 0076 Per-(signal type, review phase) email-intelligence review prompts

## What this does

Splits the single global email-intelligence system prompt into:

- a **hidden, hard-coded action-proposing core** ("how to act") that lives in
  code (`artifacts/api-server/src/lib/emailIntelPrompts.ts`) — admins can neither
  see nor edit it, and it is **never** stored in the DB; and
- admin-editable **per-(signal type, review phase) review prompts**, versioned in
  `email_intel_prompts`.

Signal types (6): `linkedin_job_change`, `auto_responder_move`, `bounce`
(covers `bounce_invalid` + `bounce_soft`), `signature_update`,
`grant_opportunity`, `thank_you_acknowledgment`. Phases (2): `accuracy`,
`suppression`. `wildflower_update` is intentionally out (those rows are
materialized already-analyzed and never go through AI review).

### Schema (additive)

1. enum `email_intel_signal_type`
2. enum `email_intel_review_phase` (`accuracy | suppression`)
3. `email_intel_prompts.signal_type`, `.review_phase` — both **nullable**
4. index swap: drop the OLD global active/draft partial uniques (one active
   total) and add per-key composite partial uniques on
   `(signal_type, review_phase)` `WHERE status = 'active'/'draft'`

### Data (one-time)

5. Demote every legacy combined-prompt row (`signal_type IS NULL`) still
   `active`/`draft` to `archived`. Under the new model the global active/draft
   row is meaningless (the pipeline resolves a prompt per review key) and a
   null-keyed row can never occupy a per-key slot, so it is retained as history
   only. **No prompt text is lost.**

## Why a hand-applied SQL file (not just Publish)

The agent cannot write to prod, and the legacy-row demotion (step 5) is a **data**
change Publish never performs. Steps 1–4 are included so the file is
self-contained and safe whether or not the Publish schema diff has already landed
them (all guarded / `IF [NOT] EXISTS`).

## Apply

Run **after** Publish has shipped the new code (so nothing reads the old global
active row), or directly — the demotion is order-independent because the hidden
core + per-key resolution no longer reads the legacy row regardless.

```bash
# dev
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0076_email_intel_review_prompts.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
# prod
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0076_email_intel_review_prompts.sql
```

`psql -1` wraps the whole file in one transaction; the file has no top-level
`BEGIN/COMMIT` (only the PL/pgSQL `DO $$ … $$` enum guards).

## Idempotency

Safe to re-run: enums are guarded by `pg_type` checks, columns use
`ADD COLUMN IF NOT EXISTS`, indexes use `DROP INDEX IF EXISTS` +
`CREATE UNIQUE INDEX IF NOT EXISTS`, and the demotion matches zero rows once all
legacy rows are archived.

## Verify

```sql
SELECT unnest(enum_range(NULL::email_intel_signal_type));
-- Expect: linkedin_job_change, auto_responder_move, bounce,
--   signature_update, grant_opportunity, thank_you_acknowledgment

SELECT unnest(enum_range(NULL::email_intel_review_phase));
-- Expect: accuracy, suppression

SELECT status, count(*)
  FROM email_intel_prompts
 WHERE signal_type IS NULL
 GROUP BY status;
-- Expect: no 'active' or 'draft' rows remain (only 'archived', if any).
```
