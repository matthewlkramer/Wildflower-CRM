---
name: opportunity/pledge lifecycle redesign
description: Final intended end-state for the opp/pledge lifecycle (cash-in, was_pledge, grant-letter, conditional rules) confirmed by the user; partly supersedes the original verbal-confirmation task plan.
---

# Opportunity / pledge lifecycle — confirmed end-state

User-confirmed design (2026-06-04). Implement on main **only after the
verbal-confirmation reclassification task merges** — that task rewrites
`pledgeStage.ts`, the opportunity schema, routes, and `opportunity-detail.tsx`,
so building earlier collides with it. The user explicitly chose to let those
tasks land first, then have main agent layer these decisions on top.

## Decisions

1. **Cash-in is payment-driven ONLY.** Status reaches `cash_in` solely when
   recorded gifts ≥ awarded. Remove the ability to *manually* mark cash-in:
   drop `stage = cash_in` as a status trigger and remove `cash_in` from the
   user-selectable stage/status pickers.
   **Why:** prevents opportunities reported as cash-in with $0 actually logged;
   keeps the gifts table the single source of truth for money received.

2. **`was_pledge` set ONLY by explicit user choice — stop auto-flagging from
   ANY stage.** At *written confirmation* the UI prompts: immediate gift
   (`was_pledge` stays false; await the single gift) vs pledge (`was_pledge`
   true; confirm allocations; await gifts over time).
   **Why:** distinguishes a written confirmation of an immediate one-off gift
   from a true future/multi-part pledge, so the Pledges page shows only real
   pledges.

3. **Grant letter no longer auto-marks a pledge.**
   **Why:** grant letters can simply document how immediately-paid money is to
   be used — they don't imply a future commitment.

4. **`conditional_commitment` no longer auto-flags a pledge either.**
   **Why:** conditionality is captured by the `conditional` enum; a conditional
   commitment can become a written commitment with that enum set — the pledge
   decision is made at written confirmation, not at the conditional stage.

5. **Data-integrity tag/flag:** flag existing opp/pledge records currently
   cash-in but with missing/inadequate payments, so staff can investigate.

## Relationship to the verbal-confirmation task
That task only reclassifies verbal as an opportunity and KEEPS
written/conditional/grant-letter auto-pledging. Items 2–4 above intentionally
go further and supersede that behavior once it merges.
