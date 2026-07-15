---
name: Canonical person display-name SQL
description: All person-name display SQL must use the shared helper (preferred/nickname+last → full_name → first+last); match predicates are exempt.
---

Person display names in server SQL follow one canonical fallback chain, PREFERRED-NAME FIRST: `CASE WHEN nickname set THEN nickname + ' ' + last_name END` → `full_name` → `first_name + last_name`, implemented once in `artifacts/api-server/src/lib/personNameSql.ts` (`personDisplayNameSql`, takes a column set so `alias(people, ...)` works too). Raw-SQL blocks that can't use the drizzle helper mirror the same COALESCE chain inline. The client mirror is `personDisplayName()` in the CRM's `lib/person.ts`, and the people-list default sort key mirrors it too (so "Tommy Barrett" sorts under T).

**Why:** display sites had drifted (some missing the nickname arm), so the same person rendered differently across lists/analytics/reconciliation. A 2026-07 sweep converted every display site to the helper. Then the user decided (2026-07) that `nickname` holds the person's *preferred* name (the name they go by — "Tommy" for "Thomas Barrett III"), so when set it REPLACES the first name in display ("Tommy Barrett") instead of being a last-resort fallback. UI labels say "Preferred name"; the DB/API field intentionally stays `nickname` (a column rename would need a prod migration + contract churn for zero user-visible gain).

**How to apply:** any NEW select that renders a person name must use the helper (or mirror the chain in raw SQL) — never hand-roll a partial COALESCE. Match-only ILIKE search predicates are intentionally exempt (they may match on fewer/more arms by design; the list-route search predicate matches nicknames). Side effect to remember: converting a search predicate to the helper changes match behavior, not just display. Formal first/full names remain untouched in the DB — only display output changes.
