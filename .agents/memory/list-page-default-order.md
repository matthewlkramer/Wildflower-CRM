---
name: List-page default sort order
description: CRM list pages display a computed name; the server default order must mirror it and carry a unique-column tiebreaker.
---

The Individuals (people) list renders the entity's *display name*
(`personDisplayName` = full_name -> first+last -> nickname -> "Person <id>"),
but the server list query historically defaulted to `ORDER BY last_name,
first_name`. That makes the default (un-clicked) list look unsorted next to the
visible "First Last" name and disagree with the client click-to-sort order. The
same display-name-vs-stored-columns gap can exist on the other list pages
(organizations / opportunities / gifts).

Rule: a list endpoint's default order should mirror the displayed name AND
always end with a unique-column tiebreaker (e.g. `asc(people.id)`).

**Why:** without a deterministic secondary key, offset/limit pagination can
shuffle rows with identical display names across page boundaries (rows
duplicated or skipped) — a subtle cousin of the user-reported "alphabet restarts
mid-list" bug. Mirroring the display name also keeps default order == click-sort
order so the list never looks unsorted.

**How to apply:** build the ORDER BY from the same fallback chain the UI uses for
the name, lowercased for case-insensitive sort, then append the PK as the final
sort key. Anonymous masking is UI-only — do NOT replicate it in SQL. The order
expr lives in the outer single-table query (no joins), so quoting columns as
`"people"."col"` is unambiguous (the bare-column footgun only bites in
correlated subqueries / aliased joins).
