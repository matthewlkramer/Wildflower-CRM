---
name: Bulk-action by-id load gate
description: Bulk dialogs that re-fetch the selection by id must gate submit on full load.
---

When a bulk-action dialog resolves each selected row by id (because the
selection can span pages/filters) instead of reusing the current page's rows,
the fetched set can lag behind — or partially fail — the selection.

**Rule:** the dialog must build its mutation payload from the *full* selection
and BLOCK submit until every selected row has loaded. Gate on
`loadedCount === expectedCount && !loadError`, where `expectedCount` is the
selection size — never just `fetched.length >= 1/2`.

**Why:** otherwise a destructive (merge/delete) or non-destructive bulk op
silently runs on whatever subset happened to load, merging/deleting fewer rows
than the user selected. Surfaced in the gifts-page merge dialogs.

**How to apply:** pass `expectedCount` + a `loadError` flag into the dialog;
show a "Loading selected (X/Y)…" line while blocked; keep the gate a pure,
unit-tested helper.
