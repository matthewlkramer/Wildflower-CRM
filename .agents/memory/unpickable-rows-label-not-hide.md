---
name: Unpickable rows are labeled, never hidden
description: Product-wide UX rule — pick lists/search results must show blocked rows with their blocking reason instead of filtering them out.
---

**Rule:** In any pick list, search result, or candidate queue (e.g. reconciliation
qb-search deposit picker), do NOT filter out rows that can't currently be acted
on (excluded, already settled elsewhere, already booked, grouped, …). Return
them WITH a clear label/reason for why they're blocked, and let the UI gray or
disable them.

**Why:** User decision (2026-07-14): "we do not hide unpickable rows. we just
label them with what the issues are. that way, the user can help us debug the
system." A silently-missing row makes data problems invisible; a labeled row
lets the user spot that the system mis-derived a status.

**How to apply:** When tempted to add a WHERE predicate that removes
"ineligible" rows from a search/pick endpoint, instead select the blocking fact
and surface it as a reason field on the candidate (like `alreadyLinkedGiftId`
graying). Server-side action endpoints still enforce the block with a specific
409 message — visibility is for debugging, enforcement stays server-side.
