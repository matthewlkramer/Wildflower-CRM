---
name: List-page pagination & PageJumper
description: How the wildflower-crm list pages render pagination and where the editable page-jump box lives.
---

# List-page pagination

The "{page} / {totalPages}" pagination control is **duplicated**, not shared,
across the 6 entity list pages (individuals, opportunities, gifts,
funding-entities, payment-intermediaries, interactions). Each page builds its
own `<Pagination><PaginationContent>…` block inline with local `page` /
`totalPages` state and a `setPage` setter.

## PageJumper

`src/components/page-jumper.tsx` is a reusable editable page indicator: a
controlled numeric `<input>` (current page) + "/ totalPages". Commits on Enter
or blur via `onJump`, reverts empty/out-of-range input, Escape cancels.

It now drives pagination on **all 6 entity list pages** (Individuals first,
then the other 5). To add it to a new list page, drop `<PageJumper page={page}
totalPages={totalPages} onJump={setPage} />` into the middle `<PaginationItem>`
between Prev/Next. Per-page quirks worth knowing:
- **payment-intermediaries** previously rendered a *numbered* page-link loop
  (`Array.from({length: totalPages})…map → PaginationLink`); that was replaced
  by a single PageJumper (one-click numbered links intentionally dropped).
- **interactions** names its total `pageCount` (not `totalPages`), so it passes
  `totalPages={pageCount}`.

**Not included (different pagination style):** `admin.tsx` and `audit-log.tsx`
use a plain-text `Page X of Y` indicator and do NOT use the shadcn Pagination
component — they were left out of the "all list pages" rollout on purpose.

**Gotcha:** a programmatic `blur()` after Enter/Escape fires `onBlur` before
React applies the pending `setValue`, so the blur handler would re-commit the
stale typed value (Escape would jump instead of cancel). PageJumper guards this
with a `skipBlurRef` set just before the programmatic blur.
