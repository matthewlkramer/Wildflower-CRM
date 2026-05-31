---
name: wildflower list-page filter/column chooser pattern
description: Shared convention for the 4 CRM list pages' toolbar filter & column choosers and their saved-view backward-compat contract.
---

All 4 list pages (individuals, funding-entities, opportunities [shared with pledges], gifts) share a toolbar customization pattern. There is a column chooser (`src/lib/columns.tsx`) and a parallel filter chooser (`src/lib/filters.tsx` + `components/filters-menu.tsx`). Treat them as siblings — new list pages and new filters must follow this same shape.

**Saved-view backward-compat rule (do not break):**
- State blobs (`ColumnsState`, `FiltersState`) are persisted as `null` when at registry defaults. This keeps the saved-views shallow-equal comparator treating "never touched it" as equal to a saved view that predates the feature.
- `FiltersState = { known: string[]; hidden: string[] }`. `resolveFilters` uses `known` to tell whether a saved view predates a given registry filter: an unknown registry key follows its registry `defaultVisible` default rather than the saved hidden list. **Why:** so a newly-introduced opt-in filter (`defaultVisible:false`) stays hidden until the user has actually seen/toggled it, instead of popping into every old saved view.
- Required filters (the name search box) are never hideable.
- Hiding a filter that currently holds a value must call its `clear` callback so a hidden filter never silently narrows results.

**How to apply:** when adding a filter to a page, give it a stable `key`, set `defaultVisible:false` for opt-in/rollup filters, wire its value into `clearAll`/`apply`/`isDefault`/`hasActiveFilters` AND into `SavedViewsBar.canSave`, and add the value to the page's `View` type. Compute any default-comparison vars (e.g. `sameDefaultStatus`) ABOVE the `filterRegistry` useMemo — the registry references them, so a TS "used before declaration" error appears if they sit after it.

**Presence filters:** rollup/computed columns use presence filters (`PresenceFilter`, value `"has" | "blank" | undefined`) sent as `<field>Presence` query params, not value filters. Server WHERE semantics: numeric has=`>0`/blank=`<=0`; date/EXISTS has=NOT NULL/EXISTS, blank=opposite; counts/array-rollups has=`>0`/EXISTS, blank=`=0`/NOT EXISTS. Reuse the same correlated subquery expr in SELECT and WHERE to avoid drift.
