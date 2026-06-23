---
name: Record-detail card empty-collapse default
description: Convention for when shared FieldCard/RelatedCard start collapsed on record pages
---

On wildflower-crm record detail pages, shared `FieldCard`/`RelatedCard` start
COLLAPSED on first render when they hold no real content, expanded otherwise.
Default-on-first-render only (no persistence).

**Decisions / invariants:**
- Placeholder "—" rows are NOT content — emptiness is computed from the real
  underlying fields, not from whether a row renders.
- An explicit `defaultOpen={false}` always wins over emptiness (some cards are
  intentionally collapsed regardless).
- For a card whose content arrives from a SEPARATE query (e.g. People cards fed by
  org/household/intermediary detail; linked-records fed by their own list query),
  emptiness must DEFER while that query is loading — never decide "empty" from
  not-yet-loaded data, or the card collapses at mount and stays collapsed after the
  rows arrive. The convention: leave emptiness unknown during load and only
  auto-collapse once, after it resolves empty; never auto-reopen (respects a user
  who toggled mid-load).
- A card that shows content BEYOND its counted list (e.g. "Gives through" keeps
  showing suggestions when its links are empty) must report itself non-empty in
  that case, so the count alone can't be trusted.

**Why:** record pages had long columns of always-open empty cards. The async-defer
rule is the subtle part that's easy to regress.
