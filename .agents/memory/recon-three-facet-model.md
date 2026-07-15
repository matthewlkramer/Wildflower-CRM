---
name: Reconciliation three-facet vocabulary & worklist model
description: Owner-ratified conceptual model for reconciliation UI — who/why | transaction | accounting, linkage vs adequacy, stray lanes, drag-to-link semantics.
---

Owner-ratified (2026-07) conceptual model for all reconciliation UI work:

**Canonical vocabulary** — the three facets of every money unit are
`WHO & WHY` (donor-shaped commitment; a CRM gift/pledge is merely the
implementation, never a synonym), `TRANSACTION` (what came in, how, when —
Stripe charge/payout, check image, ACH line), `ACCOUNTING` (where it ended up —
the QB-coded record). Check/ACH: one QB record satisfies transaction AND
accounting ("one record, two roles").

**Ideal record shapes** — who/why is shaped the way the donor thinks: one
commitment header ("$150k, 3 purposes, 4 payments over 2 years") with ALL
sub-detail as allocation rows. Accounting ideal (confirmed nonprofit-QB
practice): one record per actual money movement, purposes as split LINES within
it; journal entries only for adjustments/releases-from-restriction (JEs bypass
A/R and bank-feed matching). The two ideals are duals — who/why structure lives
in QB lines, not extra records.

**Two independent signals per facet** — LINKAGE (is a record linked at all?) vs
ADEQUACY (is the linked record complete — grant letter, campaign attribution,
check image, entity coding?). UI must never conflate them; a reviewer must see
"no record" vs "record missing key info" at a glance.

**Worklist layout** — rows are MONEY UNITS, not anchored on any facet (owner
iterated to this explicitly): the QB record is just one component slot —
usually the first present — and its coding inadequacy shows INSIDE its chip.
An unsynced Stripe charge is simply a unit with an empty accounting slot; a
check renders ONE QB record spanning transaction+accounting with per-role
adequacy. Two ALWAYS-glanceable collapsed side lanes remain: stray
transactions and stray who/why records.

**Drag semantics** — who/why→who/why offers "group as allocations of one
commitment" OR "mark as double entry"; who/why→transaction links durably until
explicit delink, after which searches treat the pair as ONE object with two
components.

**Why:** the owner articulated this model explicitly and it maps onto the
shipped ledger (drag-link = counted application; delink = revert; double-entry
= merge path; group-as-allocations ≈ pledge+allocations / split-gift-transform).
**How to apply:** use this vocabulary and the linkage/adequacy split in any
future reconciliation screen or backend status design; per-facet enrichment
status is additive and not yet computed anywhere.
