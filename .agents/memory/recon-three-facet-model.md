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
**Owner RATIFIED grain C** with refinements: summary-row cells compact but
COMPLETE per facet (amounts, counts, dates — sentences not required);
many-to-many is the norm — a payout bundle's accounting side usually holds
TWO QB records: a GROSS payment + a processor fee (negative) that SUM TO NET,
the amount the bank deposit was for (so the bundle balance rule is
gifts = gross, gross + fee = net deposit — NOT gift-vs-deposit equality);
QB deposits and QB payments both land in staged payments and are
interchangeable for this form; third column renamed "Accounting & bank rec"
(QB is populated from bank deposits); mini cards lead with matching-useful
info (date, purpose, donor/indiv/hh name); who/why cards carry THREE badges:
Donorbox-matched, coding-form attached, grant-letter attached; every card
(all three facets) has a "⋯" dropdown action menu — search Donorbox, search
coding forms, upload grant letter, unlink from cluster, split, group with
another record, replace intermediary with donor, exclude from workbench —
NOT inline per-action buttons; sub-rows indent under the summary row; EVERY
card states its own standalone completeness ("Missing grant letter",
"Missing class coding") — separate from linkage.

**Workbench v2 synthesis (owner spec, mocked)** — columns renamed DONOR &
PURPOSE / PAYMENT EVIDENCE / BANK & ACCOUNTING. Right rail: lenses (All
unresolved, Needs donor or gift, Needs accounting, Settlement gaps,
Conflicts, Refunds, Excluded, Completed) + recent changes with one-click
Undo. Cluster header must ALWAYS answer: what money event / how much / is it
balanced / decisions remaining — metrics strip Gross·Fees·Bank·Gap·n/m
resolved, never inferred from child rows. TWO independent header indicators:
Money (BALANCED/MISMATCH) and Attribution (n/m complete) — "balanced but
incomplete" ≠ "complete but mismatched". ONE status per grain: cluster
statuses READY/PARTIAL/CONFLICT/BALANCED/EXCLUDED as a rollup WITH detail
("PARTIAL · 3 of 4 complete · $99.10 unresolved"); transaction statuses
READY TO APPROVE/NEEDS DONOR/NEEDS GIFT/NEEDS ACCOUNTING/AMOUNT
MISMATCH/CONFLICT/DONE. Every unresolved row shows ONE explicit primary
action naming the missing decision (Choose donor / Choose gift / Approve
match / Tie to deposit / Resolve conflict / Review refund) — never a generic
"Resolve"; secondary actions (Exclude, Flag for research, Move to another
gift, Split, View source) in the ⋯ menu. Compact diagnostic under every
unresolved status ("No donor identified", "Gift amount differs by $X").
Selecting a cluster/child opens a focus view: cluster dossier (totals,
completeness math, included/missing charges, fee accounting, settlement
link, conflicts, repair actions) + persistent child inspector (donor&gift,
processor txn, QBO relationship, gross/fee/net/refund, match rationale,
ledger applications, source lineage, audit history, actions).

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
