---
name: QuickBooks reconciler left-card UI model
description: Why the staged-payment left cards have no donor picker, why "reject" is UI-removed but backend-kept, and which exclusion reasons are manual-only.
---

The QuickBooks reconciler (`staged-payments.tsx`) is a two-pane reconciler. Donor
matching is driven ENTIRELY from the RIGHT pane (select a left payment + a right
gift → reconcile). The LEFT needs-review cards are intentionally read-only for
donor/gift linkage — no per-row donor picker, no Save/Confirm-donor buttons.

**Why:** the per-row donor picker duplicated the right-pane match flow and
confused operators. Reconcile adopts the donor from the chosen gift, so a left
picker is unnecessary. Don't re-add a donor picker to the left card.

**Reject vs Exclude:** the `reject` status/endpoint/queue still exist in the
backend and the Rejected queue is still listed, but there is NO UI action to
create a rejection anymore — it was confusing (its "reasons" were really
exclusion reasons). All dismissal now goes through Exclude.
**Why:** kept backend-side for non-destructiveness and so any historical rejected
rows in prod stay viewable. Do not drop the `rejected` enum value/endpoint.

**Manual-only exclusion reasons:** `intercompany_transfer` and `other` are picked
by a human in the reconciler; the insert-time classifier never auto-assigns them
(so no SQL backfill is needed when they're introduced — unlike the auto-assigned
reasons, which require the classifier↔backfill lockstep). The badge-adjacent
"Unmatch" toggle on needs-review cards reuses the pending-only unmatch endpoint.
