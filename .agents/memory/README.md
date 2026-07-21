# Memory Policy

`.agents/memory/` holds durable implementation lessons and routing indexes. It
is supplemental context, never canonical architecture. Canonical business rules
and architecture live in `docs/`; the operating contract lives in `replit.md`.

## Reading rules

1. Start from [`MEMORY.md`](MEMORY.md) and open only the topic files relevant to
   the task. Never bulk-load this directory.
2. When memory conflicts with `replit.md`, a canonical `docs/` document, the
   Drizzle schema, or `lib/api-spec/openapi.yaml`, trust the current code/docs
   and fix or archive the stale memory in the same change.

## Writing rules

1. One topic per file, with YAML frontmatter (`name`, `description`) so the file
   is findable by grep.
2. A useful note states: the durable rule, why it matters (incident or
   decision), how to apply it, and — for transitional notes — the condition
   under which it should be retired.
3. Do not record things derivable from the current code (file layouts, function
   signatures, column lists), implementation changelogs, or conversation-local
   identifiers (task numbers). Extract the durable lesson instead.
4. Update the existing entry rather than writing a duplicate. Keep `MEMORY.md`
   an index of one-line pointers; detail belongs in topic files.
5. Never store secrets, credentials, or PII.

## Retirement rules

1. When a subsystem is redesigned, update or archive its memory in the same
   change — do not leave two "current" stories.
2. Historical material moves under `legacy/` (or a dated `archive/` directory)
   with an index explaining why it was retired. Historical files must never be
   linked as current guidance.
3. Prefer deleting a stale note over hedging it. Git history preserves the old
   text.
