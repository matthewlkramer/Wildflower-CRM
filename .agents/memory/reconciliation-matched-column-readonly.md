---
name: Reconciliation Matched column is a read-only report
description: Why the workbench "Matched"/done column must render cards view-only, and why gate by column not derived status.
---

The Reconciliation Workbench's **Matched** column (fed by the `done` queue,
`queue="done"`) shows settled money already tied to a gift. Its cards MUST render
read-only: no group-select checkbox and no confirm/create/reject/ResolveMenu
actions — only a static "Reconciled to <gift>" indicator.

**Why:** the shared `renderReconCard`/`ReconCard` exposes a live "Confirm match"
(ResolveMenu → confirmAndApply → group-reconcile) and a group-select checkbox. On
a settled source-group card these route back into the server group-reconcile
guard, which 409s ("one/more of these staged payments already resolved") because
none of the member `staged_payments` are `pending` anymore. This was the
Arthur Rock Foundation $1.6M DAF bug: a 3-row `reconciled` source group whose
"Confirm match" 409'd.

**How to apply:** gate read-only by the **column** (pass `{ readOnly: true }` from
the Matched column into `renderReconCard`), NOT by a derived status. A reconciled
*grouped* card whose gift amount diverges beyond the fee band reads
`deriveCardStatus` = "partial"/"multiple" (not "confirmed"), so status-driven
gating would leak live actions on exactly those grouped cards. The other columns
(research, "Donor not credited") serve only `pending` rows by server construction,
so they keep full actions. Also hide the match-confidence chip in read-only mode —
`confidenceOf` reads "Weak" for a resolved-but-no-proposed-gift card, which is
misleading on settled money.

Read-only here is not a regression: pre-redesign the old "Confirmed" queue was a
never-wired stub, so confirmed money was never re-actionable in the workbench.
Corrections to a bad match happen on the gift itself (gift detail / revert paths),
not in the Matched report. Coding edits (`set-coding`) stay allowed on any row by
design (orthogonal to reconcile status) and cannot 409.
