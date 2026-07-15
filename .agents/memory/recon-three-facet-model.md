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

**Worklist layout (latest iteration: PEER model, no unit object)** — owner
iterated QB-anchored → money-unit rows → pure peers: only the three record
kinds + LINKS (with amounts) exist; a row is a CLUSTER of linked records and
the "unit" is just the name for a cluster, derived not stored. Consequences
the owner ratified by asking for this: strays = clusters of one, inline in
the same list (side lanes become LENSES/filters); exclusion is a property of
the accounting record itself, not a container; each chip carries its own
amount+date+identity, and coding inadequacy shows INSIDE the owning record's
chip. A check renders ONE QB record spanning transaction+accounting with
per-role adequacy. Every-dollar-once survives without the object: each facet
plane sums independently, links assert correspondences. Open design point:
display grain for big clusters (deposit w/ 4 charges) — three candidates
mocked side-by-side: (A) one row per cluster, cells hold stacked record sets
(list = money events; per-donor work buried, rows can be "¾ done");
(B) one row per transaction, shared records span rows via rowSpan (one row =
one decision; list inflates, cluster doneness lives in the spanning chip's
margin); (C) adaptive — browse at cluster grain, expand to per-transaction
sub-rows, status rolls up (both counts honest; costs a second UI level).
Simple 1:1:1 clusters and strays render identically in all three grains.

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
