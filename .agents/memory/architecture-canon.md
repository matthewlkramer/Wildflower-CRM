---
name: Canonical architecture map
description: Authority hierarchy and entry-point documents for non-trivial changes; read before touching a subsystem.
---

# Canonical architecture & authority map

The authority order for conflicting sources is defined in `replit.md` (the
operating contract). The documentation map and status vocabulary live in
`docs/README.md`.

Entry points, in reading order for any non-trivial change:

1. `replit.md` — invariants: contract-first; header + allocations; one
   authority per derived fact; donor XOR; loan/revenue separation; canonical
   money link tables; refunds are transaction facts; archive by default;
   human-gated prod; reduction as the success criterion.
2. `docs/README.md` — which document is canonical for the subsystem, with the
   `status`/`last_verified` vocabulary.
3. For reconciliation: `docs/reconciliation-status.md` (current state) →
   `docs/workbench-business-rules.md` (ratified semantics) →
   `docs/reconciliation-design.md` (target model) →
   `docs/adr-source-link-ledger.md` (evidence↔evidence ledger — implemented; `source_links` is live) and `docs/adr-linear-money-model.md` (ratified linear money model: gift = one payment event, unit-group retirement, bank-anchored target).
4. `lib/db/SCHEMA.md` — per-table reference; the Drizzle code in
   `lib/db/src/schema/*.ts` (+ `_enums.ts`) is the ultimate truth for what
   physically exists.
5. `lib/api-spec/openapi.yaml` — the public API contract.

**Why:** business-rule and design docs say what SHOULD exist; schema and code
say what DOES exist. When they disagree, record the gap in the subsystem's
current-status document instead of treating the implementation as intent.

**How to apply:** orient from the documents above; use memory topic files only
for the non-obvious lessons underneath them; trust schema code over any prose
about the physical model.
