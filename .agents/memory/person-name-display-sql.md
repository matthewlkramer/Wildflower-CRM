---
name: Canonical person display-name SQL
description: All person-name display SQL must use the shared helper (full_name → first+last → nickname); match predicates are exempt.
---

Person display names in server SQL follow one canonical fallback chain: `full_name` → `first_name + last_name` → `nickname`, implemented once in `artifacts/api-server/src/lib/personNameSql.ts` (`personDisplayNameSql`, takes a column set so `alias(people, ...)` works too). Raw-SQL blocks that can't use the drizzle helper mirror the same COALESCE chain inline.

**Why:** display sites had drifted (some missing the nickname arm), so the same person rendered differently across lists/analytics/reconciliation. A 2026-07 sweep converted every display site to the helper.

**How to apply:** any NEW select that renders a person name must use the helper (or mirror the chain in raw SQL) — never hand-roll a partial COALESCE. Match-only ILIKE search predicates are intentionally exempt (they may match on fewer/more arms by design; the list-route search predicate now also matches nicknames). Side effect to remember: converting a search predicate to the helper changes match behavior, not just display.
