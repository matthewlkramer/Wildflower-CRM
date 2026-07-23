# Documentation Map

This directory holds canonical business rules, architecture, current
implementation status, and runbooks. The agent operating contract is
[`../replit.md`](../replit.md); this file tells you what to read for each
subsystem and which document wins when two disagree.

## Status vocabulary

Major design documents declare frontmatter:

```yaml
status: ratified | current-status | design-target | proposal | runbook | historical
last_verified: YYYY-MM-DD
```

- `ratified` — product/business semantics approved by the owner. Normative even
  where current code disagrees; code differences are drift to repair, not
  precedent.
- `current-status` — describes what is actually implemented today, including
  known drift. Descriptive, not normative.
- `design-target` — the agreed future architecture; implement toward it, but the
  ratified rules and current-status docs govern behavior today.
- `proposal` — not yet approved; do not implement from it without confirmation.
- `runbook` — operational procedure for humans/agents.
- `historical` — superseded; context only. Must live under `legacy/` or be
  clearly marked.

A document without frontmatter has not yet been classified — treat it as
unverified and confirm against code before relying on it.

## Reconciliation subsystem (read in this order)

1. [`reconciliation-status.md`](reconciliation-status.md) — current
   implementation status and known drift. Read this FIRST before any
   reconciliation change.
2. [`workbench-business-rules.md`](workbench-business-rules.md) — **ratified**
   product semantics for the reconciliation workbench (rows, columns, states,
   actions). Normative.
3. [`reconciliation-design.md`](reconciliation-design.md) — target money and
   relationship model.
4. [`adr-source-link-ledger.md`](adr-source-link-ledger.md) — evidence↔evidence
   ledger (**implemented**; `source_links` is the sole authority — the
   source-specific pointer columns it replaced were dropped in migration 0149).
5. [`adr-linear-money-model.md`](adr-linear-money-model.md) — **ratified**
   coding rules (gift = one payment event; meaning splits on allocations;
   expectations on the pledge) and the bank-anchored linear target model,
   including unit-group retirement and the production recoding inventory.
   (§3's Layer-2 physical target is **superseded** by the ADR below.)
6. [`adr-bank-spine-money-model.md`](adr-bank-spine-money-model.md) —
   **ratified** successor: bank deposit is the spine; `bank_deposits`,
   `payment_units`, `bank_deposit_components` become first-class tables and QBO
   (`staged_payments` → `qbo_payment_records`) demotes to a downstream
   accounting mirror + check-inference source. Governs the reconciliation
   physical model going forward; implemented in prod-safe phases.

## Other canonical documents

- [`change-recipes.md`](change-recipes.md) — step-by-step recipes for routine
  change types (contract change, schema change, new derived fact, etc.).
- [`../lib/db/SCHEMA.md`](../lib/db/SCHEMA.md) — per-table map of the physical
  schema.
- [`integrations/data-sources.md`](integrations/data-sources.md) — data
  provenance, sync ownership, and operational resync procedures (Copper import
  is closed; schools mirror; QuickBooks/Stripe/Donorbox/Gmail/Flodesk syncs).

## Rules

- When a design changes, update or supersede the affected document in the same
  change. Never leave two documents making contradictory "current" claims.
- Historical material belongs under `legacy/` or `archive/` and must not be
  linked as current guidance.
- Implementation lessons and one-off incident notes belong in
  [`../.agents/memory/`](../.agents/memory/MEMORY.md), not here.
