---
name: shadcn Select inside Dialog scroll trap
description: Why a long shadcn/Radix Select dropdown nested in a modal Dialog is a UX trap, and what to use instead.
---

A shadcn `Select` opens a Radix popover. When that Select lives inside a modal
`Dialog` AND its option list is long (many items / grouped families), the popover
overflows the viewport and the only way to reach off-screen options is the thin
hover-only scroll buttons — which behave badly inside the Dialog's scroll/focus
trap. Users report "the dialog won't let me scroll up to see all the options."

**Rule:** for a fixed, smallish option set (~tens of items) picked inside a Dialog,
prefer an INLINE scrollable list (a `RadioGroup` with `max-h-[Nvh] overflow-y-auto`,
sticky group headers) over a nested `Select` dropdown. No popover-in-modal means no
scroll trap, and every option is directly visible/scrollable within the dialog body
while the footer stays reachable.

**Why:** the Exclude-payment dialog in the Finance Reconciliation workbench used a
Select with 16 exclusion reasons across 6 families; the nested popover cut off the
top groups and couldn't be scrolled. Swapping to an inline RadioGroup fixed it.

**How to apply:** only the in-Dialog picker needs this. A Select used as a page-level
toolbar/filter (plenty of room, no modal) is fine as-is — don't convert those.
Associate each option's text with its `RadioGroupItem` via `htmlFor`/`id` and give
the group an `aria-label`.
