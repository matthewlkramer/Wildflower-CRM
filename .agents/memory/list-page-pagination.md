---
name: List-page pagination & PageJumper
description: How the wildflower-crm list pages render pagination and where the editable page-jump box lives.
---

# List-page pagination

The "{page} / {totalPages}" pagination control is **duplicated**, not shared,
across the 6 list pages (individuals, opportunities, gifts, funding-entities,
payment-intermediaries, interactions). Each page builds its own
`<Pagination><PaginationContent>…` block inline with local `page` / `totalPages`
state and a `setPage` setter.

## PageJumper

`src/components/page-jumper.tsx` is a reusable editable page indicator: a
controlled numeric `<input>` (current page) + "/ totalPages". Commits on Enter
or blur via `onJump`, reverts empty/out-of-range input, Escape cancels.

**Why only Individuals uses it:** it was added in response to a request scoped
explicitly to the Individuals list. The other 5 list pages still render the
static `PaginationLink "{page} / {totalPages}"` — that inconsistency is
intentional, not a bug. To roll the jump box out elsewhere, drop `<PageJumper
page={page} totalPages={totalPages} onJump={setPage} />` into each page's
middle `<PaginationItem>` (replacing the static `PaginationLink`).

**Gotcha:** a programmatic `blur()` after Enter/Escape fires `onBlur` before
React applies the pending `setValue`, so the blur handler would re-commit the
stale typed value (Escape would jump instead of cancel). PageJumper guards this
with a `skipBlurRef` set just before the programmatic blur.
