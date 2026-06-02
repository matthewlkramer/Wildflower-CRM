---
name: Copper notes one-time migration
description: How the 3,752 Copper-CRM notes were imported into the notes table; conventions to reuse for similar one-time imports.
---

# Copper → CRM notes migration

One-time importer: `lib/db/src/import-copper-notes.mjs` (npm script `import:copper-notes` in `lib/db/package.json`). Fetches Copper live (Copper API key path), matches against the live DB, inserts into `notes`. Has `--dry-run`.

## Durable conventions (reuse for similar imports)
- **Idempotent by stable id**: note `id = copper_<activityId>` + `INSERT ... ON CONFLICT (id) DO NOTHING`. Safe to re-run.
- **Seeded placeholder users** carry `clerk_id = placeholder:<email>`; `requireAuth` adopts a seeded row by email on first real sign-in, preserving authorship. Placeholder user `id` must be unique per FULL email (include domain), not just local-part, or two same-local-part emails collide on the users PK.
- **HTML→plain-text order matters**: strip tags FIRST, decode entities AFTER. Reverse order would turn `&lt;b&gt;` into a strippable tag and lose `<email@x>` angle-bracket text. ~10 notes legitimately contain `<addr@x>` (decoded from `&lt;...&gt;`) — NOT broken markup.
- **Conservative matching**: people by email OR exact-unique normalized-name; company by funder/household/org exact OR forward-subset (handles slash-combined funder names); opp by `copper_pledge_id` else primary-contact+company fallback. **>1 candidate = leave UNATTACHED**, never guess.
- **notes has no organizationIds** — org-only company notes are resolved to related PEOPLE via Copper company contacts (user's explicit choice; do NOT add an organizationIds column or convert orgs to funders).

## Gotcha: long-running script vs bash 120s tool cap
The full run exceeds the 120s bash timeout (Copper pagination + per-author /users GETs). Running it foreground returns exit -1 with NO output but the orphaned node process keeps going and commits. Run it via `nohup ... > /tmp/x.log 2>&1 &` then poll the log + DB. Because it's idempotent, a re-run after a killed/orphaned run safely reports "0 new".
